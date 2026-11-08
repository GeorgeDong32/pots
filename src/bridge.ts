/**
 * M2 BridgeModule — chat_id ⇄ conversation routing, admission, and the
 * watch→post pump. P0 posture: one bound chat (`homeChatId`) routing to the
 * root conversation; every other chat is denied with a fixed notice (F23).
 */
import type { Channel, InboundMessage } from "./channel.js";
import type { Logger } from "./log.js";
import {
	partialText,
	type Conversation,
	type SubmissionId,
	type Substrate,
} from "./substrate.js";

export interface BridgeConfig {
	homeChatId: string;
	ownerOpenId: string;
}

export interface Bridge {
	/** Entry point for every inbound message (live and backfilled alike). */
	handle(msg: InboundMessage): void;
	/** Graceful shutdown: finalize streaming cards with `note`, stop pumps (F15). */
	finalize(note: string): Promise<void>;
}

/** Owner-only remote control commands (P1-4). Parsed after the policy check. */
const CONTROL_RE = /^(stop|status|compact)$|^new\s+([\s\S]+)/;

interface Pump {
	/** Immediately close the stream iterator; the card finalizes with what it has. */
	close(): void;
}

const DENY_NOTICE =
	"🚫 未绑定频道。本 agent 仅在 owner 配置的频道中工作，请让 owner 在主会话中绑定此频道。";
const DENY_COOLDOWN_MS = 10 * 60 * 1000; // Never engage in a deny-loop with a stranger chat.

export function createBridge(deps: {
	substrate: Substrate;
	channel: Channel;
	config: BridgeConfig;
	logger: Logger;
}): Bridge {
	const { substrate, channel, config, logger } = deps;
	const pumps = new Map<string, Pump>();
	const lastDenyAt = new Map<string, number>();

	channel.onMessage((msg) => void handle(msg));

	async function handle(msg: InboundMessage): Promise<void> {
		try {
			if (msg.isBot) return; // dropBots: never react to other bots (F24/P1 default)
			const { bindings, homeChatId } = await substrate.bindings();
			const binding = bindings[msg.chatId];
			// P1-1.7 deny-by-default for unbound chats (home is migrated into the table).
			if (binding === undefined) {
				if (msg.chatId === homeChatId) return; // home without a row cannot happen post-migration
				await denyNotice(msg.chatId);
				return;
			}
			// P1-4: owner-only remote control, parsed AFTER the policy gate.
			if (msg.senderId === config.ownerOpenId) {
				const match = CONTROL_RE.exec(msg.text.trim());
				if (match !== null) {
					await runControl(msg.chatId, match, binding.policy.mentionOnly && !msg.isMention);
					return;
				}
			}
			const result = await substrate.admitBinding(msg.chatId, msg);
			if (result.kind === "denied") {
				logger.info("admission denied", { chatId: msg.chatId, messageId: msg.messageId, reason: result.reason });
				return; // silent: policy denials never echo back to the sender
			}
			if (result.kind === "unbound") {
				await denyNotice(msg.chatId);
				return;
			}
			const conv = await substrate.bindingConversation(msg.chatId);
			logger.info("admitted", { chatId: msg.chatId, messageId: msg.messageId, submissionId: result.submissionId });
			void pump(conv, msg.chatId, result.submissionId);
		} catch (error) {
			logger.error("handle failed", {
				chatId: msg.chatId,
				messageId: msg.messageId,
				error: (error as Error).message,
			});
		}
	}

	/** Remote control execution (P1-4): owner-checked by the caller; mention gating for groups. */
	async function runControl(
		chatId: string,
		match: RegExpExecArray,
		needsMention: boolean,
	): Promise<void> {
		if (needsMention) return; // group commands additionally require the @-mention
		const command = match[1] ?? `new`;
		const note = match[2];
		try {
			if (command === "stop") {
				await substrate.abortConversation(chatId);
				await channel.postText(chatId, "🛑 已中止当前 run（排队消息一并撤回）。");
			} else if (command === "status") {
				await channel.postText(chatId, await substrate.statusText(chatId));
			} else if (command === "compact") {
				await substrate.compactConversation(chatId);
				await channel.postText(chatId, "🧹 已请求上下文压缩。");
			} else if (command === "new" && note !== undefined) {
				await substrate.resetConversation(chatId, note);
				await channel.postText(chatId, `🔄 已重置会话，handoff：${note.slice(0, 100)}`);
			}
		} catch (error) {
			logger.error("control failed", { chatId, command, error: (error as Error).message });
			await channel.postText(chatId, `⚠️ 命令执行失败：${(error as Error).message}`);
		}
	}

	async function denyNotice(chatId: string): Promise<void> {
		const last = lastDenyAt.get(chatId) ?? 0;
		if (Date.now() - last < DENY_COOLDOWN_MS) return;
		lastDenyAt.set(chatId, Date.now());
		try {
			await channel.postText(chatId, DENY_NOTICE);
		} catch (error) {
			logger.warn("deny notice failed", { chatId, error: (error as Error).message });
		}
	}

	/**
	 * Stream one submission's run into the chat as a single card (P0-4.2).
	 * Deltas come from `pi.live.generation.message` partials; a new attempt
	 * (multi-turn run) resets the prefix, so its text appends. A new pump for
	 * the same chat closes this one immediately (P0-4.3).
	 */
	async function pump(conv: Conversation, chatId: string, submissionId: SubmissionId): Promise<void> {
		pumps.get(chatId)?.close();

		let lastPartial = "";
		let closed = false;
		const queue: string[] = [];
		let wake: (() => void) | undefined;
		let finished = false;

		const enqueue = (chunk: string): void => {
			if (closed || chunk.length === 0) return;
			queue.push(chunk);
			wake?.();
		};
		const finish = (): void => {
			finished = true;
			wake?.();
		};

		const stream = (async function* (): AsyncGenerator<string> {
			while (true) {
				while (queue.length === 0) {
					if (finished) return;
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
					wake = undefined;
				}
				// P0-4.3: close() ends iteration from outside.
				if (closed) return;
				yield queue.shift() as string;
			}
		})();

		const stopWatch = await substrate.watch(conv, (view) => {
			const text = partialText(view.docs["pi.live"]);
			if (!text.startsWith(lastPartial)) {
				// A new attempt/turn started: its full text is fresh content.
				lastPartial = "";
			}
			const delta = text.slice(lastPartial.length);
			lastPartial = text;
			enqueue(delta);
		});

		const own: Pump = {
			close: () => {
				closed = true;
				finish();
			},
		};
		pumps.set(chatId, own);

		const submission = await substrate.submission(submissionId);
		if (submission === undefined) {
			logger.error("pump: submission vanished", { chatId, submissionId });
			stopWatch();
			if (pumps.get(chatId) === own) pumps.delete(chatId);
			return;
		}

		let pumpError: Error | undefined;
		try {
			// The card stream runs concurrently with the wait; both drive the same queue.
			const posted = channel.post(chatId, stream, (full) => {
				logger.info("card finalized", { chatId, submissionId, chars: full.length });
			});
			const settled = await submission.wait();
			if (settled.status === "done" && settled.answer !== undefined) {
				const answer = await substrate.answerText(settled.answer);
				// The committed answer is the last attempt's full text; stream the remainder.
				if (answer.startsWith(lastPartial)) {
					enqueue(answer.slice(lastPartial.length));
				} else if (answer.length > 0) {
					enqueue(`${lastPartial.length > 0 ? "\n\n" : ""}${answer}`);
				}
				finish();
			} else if (settled.status === "unanswered") {
				enqueue(`\n\n⚠️ 本次运行未获回答（${settled.reason}），可重发消息触发续跑。`);
				finish();
			} else {
				finish();
			}
			await posted;
		} catch (error) {
			pumpError = error as Error;
			finish();
		} finally {
			// Never close a successor pump that already replaced this one (P0-4.3).
			if (pumps.get(chatId) === own) {
				pumps.delete(chatId);
			}
			stopWatch();
			if (pumpError) logger.error("pump failed", { chatId, submissionId, error: pumpError.message });
		}
	}

	return {
		handle,
		async finalize(note) {
			for (const [chatId, pumpHandle] of pumps) {
				pumpHandle.close();
				// Give the closed iterator a beat so its card completes with the note.
				try {
					await channel.postText(chatId, note);
				} catch {
					// Best effort during shutdown.
				}
			}
			pumps.clear();
		},
	};
}
