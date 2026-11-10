/**
 * M1 ChannelModule — Feishu (Lark) duplex channel on the Vercel Chat SDK with
 * the official vendor adapter (`@larksuite/vercel-chat-adapter`, WS long
 * connection). Owns: handler wiring, streaming posts with a 200ms floor
 * (F17), card actions, and the lark-cli backfill read channel (F08).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Chat, type ActionEvent, type Message, type Thread } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
	channelIdFromThreadId,
	createLarkAdapter,
	decodeThreadId,
	encodeThreadId,
} from "@larksuite/vercel-chat-adapter";
import type { Logger } from "./log.ts";
import { sessionKey } from "./session-key.ts";
import type { ApprovalCardData } from "./approvals.ts";
import { buildApprovalCard } from "./cards.ts";

const execFileAsync = promisify(execFile);

export interface InboundMessage {
	chatId: string;
	messageId: string;
	text: string;
	senderId: string;
	isMention: boolean;
	isBot: boolean;
	sentAt: number; // Lark server epoch ms when known, else Date.now()
	/** Empty or absent is the channel root. A Feishu root message id selects that thread's session. */
	threadId?: string;
}

export interface CardAction {
	actionId: string;
	/** Approval id carried in the button value (P1). */
	value?: string;
	operatorOpenId: string;
	chatId: string;
	messageId: string;
}

export interface Channel {
	/** Register the inbound message callback; the handler must return fast (3s Lark ack). */
	onMessage(cb: (m: InboundMessage) => void): void;
	/** Stream a reply into a chat as one card. Resolves true only when a send was accepted. */
	post(chatId: string, chunks: AsyncIterable<string>, done?: (full: string) => void, threadId?: string): Promise<boolean>;
	/** Post a plain one-shot text message (notices, escalations). */
	postText(chatId: string, text: string): Promise<void>;
	/** Post an approval card with Approve/Always/Deny buttons (M5). */
	postCard(chatId: string, card: ApprovalCardData): Promise<void>;
	onCardAction(cb: (a: CardAction) => void): void;
	/** Read messages a disconnect window may have missed; duplicates are absorbed upstream. */
	backfill(chatId: string, since: Date): Promise<InboundMessage[]>;
	start(): Promise<void>;
	stop(): Promise<void>;
}

/** Hermes-style burst merge defaults (P1-1.6). */
export interface BurstOptions {
	enabled: boolean;
	silenceMs: number; // text window
	mediaSilenceMs: number; // window once media is seen
	maxMessages: number;
	maxChars: number;
}

export const DEFAULT_BURST: BurstOptions = {
	enabled: true,
	silenceMs: 600,
	mediaSilenceMs: 800,
	maxMessages: 8,
	maxChars: 4000,
};


/**
 * Hermes-style burst merger (P1-1.6): a silence window flushes the batch
 * (0.6s text / 0.8s after media), capped at 8 messages / 4000 chars; a new
 * sender or a cap hit flushes early. Merged requestIds are deterministic
 * per batch, so redelivery of the same window re-merges identically.
 */
export interface BurstMerger {
	push(inbound: InboundMessage): void;
	flushAll(): void;
}

export function createBurstMerger(options: BurstOptions, emit: (m: InboundMessage) => void): BurstMerger {
	const state = new Map<
		string,
		{
			chatId: string;
			threadId?: string;
			texts: string[];
			chars: number;
			firstId: string;
			lastId: string;
			lastSender: string;
			lastSentAt: number;
			hasMedia: boolean;
			isMention: boolean;
			timer: ReturnType<typeof setTimeout> | undefined;
		}
	>();

	function flush(key: string): void {
		const batch = state.get(key);
		state.delete(key);
		if (batch === undefined) return;
		if (batch.timer !== undefined) clearTimeout(batch.timer);
		if (batch.texts.length === 0) return;
		emit({
			chatId: batch.chatId,
			threadId: batch.threadId,
			messageId: batch.texts.length === 1 ? batch.firstId : `${batch.firstId}..${batch.lastId}`,
			text: batch.texts.join("\n"),
			senderId: batch.lastSender,
			isMention: batch.isMention,
			isBot: false,
			sentAt: batch.lastSentAt,
		});
	}

	return {
		push(inbound) {
			if (!options.enabled) {
				emit(inbound);
				return;
			}
			const key = sessionKey(inbound.chatId, inbound.threadId);
			let batch = state.get(key);
			if (
				batch !== undefined &&
				(batch.lastSender !== inbound.senderId ||
					batch.texts.length >= options.maxMessages ||
					batch.chars >= options.maxChars)
			) {
				flush(key);
				batch = undefined;
			}
			if (batch === undefined) {
				batch = {
					chatId: inbound.chatId,
					threadId: inbound.threadId,
					texts: [],
					chars: 0,
					firstId: inbound.messageId,
					lastId: inbound.messageId,
					lastSender: inbound.senderId,
					lastSentAt: inbound.sentAt,
					hasMedia: false,
					isMention: false,
					timer: undefined,
				};
				state.set(key, batch);
			}
			batch.texts.push(inbound.text);
			batch.chars += inbound.text.length;
			batch.lastId = inbound.messageId;
			batch.lastSender = inbound.senderId;
			batch.lastSentAt = inbound.sentAt;
			batch.isMention = batch.isMention || inbound.isMention;
			if (batch.timer !== undefined) clearTimeout(batch.timer);
			const window = batch.hasMedia ? options.mediaSilenceMs : options.silenceMs;
			batch.timer = setTimeout(() => flush(key), window);
		},
		flushAll() {
			for (const chatId of [...state.keys()]) flush(chatId);
		},
	};
}

export interface ChannelOptions {
	appId: string;
	appSecret: string;
	botName: string;
	larkCliPath: string;
	logger: Logger;
	/** Minimum interval between streamed chunks (F17: card 10 QPS headroom). */
	minChunkIntervalMs?: number;
	/** Inbound burst merging; pass {enabled:false} to admit messages one by one. */
	burst?: BurstOptions;
}

/** Injectable process runner so tests can stub lark-cli. */
export type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;
export const defaultRunner: CommandRunner = async (file, args) => execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 });

export function createChannel(options: ChannelOptions, runner: CommandRunner = defaultRunner): Channel {
	const minInterval = options.minChunkIntervalMs ?? 200;
	const burst = options.burst ?? DEFAULT_BURST;
	let messageCb: ((m: InboundMessage) => void) | undefined;
	let cardCb: ((a: CardAction) => void) | undefined;

	const bot = new Chat({
		userName: options.botName,
		adapters: { lark: createLarkAdapter({ appId: options.appId, appSecret: options.appSecret }) },
		state: createMemoryState(),
		concurrency: "queue",
	});

	/** Most recent live SDK thread per session, so replies land in that Feishu thread. */
	const threads = new Map<string, Thread>();

	function rememberThread(chatId: string, thread: Thread): void {
		threads.set(chatId, thread);
		// Bound the cache; one thread per chat is all we need.
		if (threads.size > 100) threads.delete(threads.keys().next().value as string);
	}

	async function threadFor(chatId: string, threadId = ""): Promise<Thread> {
		const live = threads.get(sessionKey(chatId, threadId));
		if (live) return live;
		return bot.thread(encodeThreadId({ chatId, rootId: threadId }));
	}

	function threadRoot(encoded: string): string {
		try {
			return decodeThreadId(encoded).rootId ?? "";
		} catch {
			return "";
		}
	}

	// Burst merging (P1-1.6), via the exported testable merger.
	const merger = createBurstMerger(burst, (merged) => messageCb?.(merged));
	const intoBurst = merger.push;

	function dispatch(thread: Thread, message: Message): void {
		const chatId = channelIdFromThreadId(message.threadId);
		const threadId = threadRoot(message.threadId);
		rememberThread(sessionKey(chatId, threadId), thread);
		// Bot authors never produce agent input (channel-level; policy re-checks in commit).
		const isBot = message.author.isBot === true;
		if (isBot) return;
		const inbound: InboundMessage = {
			chatId,
			messageId: message.id,
			text: message.text,
			senderId: message.author.userId ?? "",
			isMention: message.isMention === true,
			isBot,
			sentAt: Date.now(),
			...(threadId ? { threadId } : {}),
		};
		intoBurst(inbound);
	}

	// Registration order is routing order: DMs first, then mentions, then the rest.
	bot.onDirectMessage((thread, message) => dispatch(thread, message));
	bot.onNewMention((thread, message) => dispatch(thread, message));
	bot.onSubscribedMessage((thread, message) => dispatch(thread, message));
	bot.onNewMessage((thread, message) => dispatch(thread, message));

	bot.onAction((event: ActionEvent) => {
		const chatId = event.threadId ? safeChatId(event.threadId) : "";
		cardCb?.({
			actionId: event.actionId,
			value: event.value,
			operatorOpenId: event.user.userId ?? "",
			chatId,
			messageId: event.messageId ?? "",
		});
	});

	function safeChatId(threadId: string): string {
		try {
			return channelIdFromThreadId(threadId);
		} catch {
			return "";
		}
	}

	/** Enforce the minimum interval between yields (F17). */
	async function* throttled(chunks: AsyncIterable<string>): AsyncGenerator<string> {
		let last = 0;
		for await (const chunk of chunks) {
			const now = Date.now();
			const wait = last + minInterval - now;
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
			last = Date.now();
			yield chunk;
		}
	}

	// P3-2.3: group chats share 5 QPS across ALL bots — stay under it with a
	// 4 QPS send pace; texts that queue up while spacing elapses coalesce into
	// one message (over-limit merges into a single card).
	const sendQueue = new Map<string, string[]>();
	let draining = false;
	const sendSpacingMs = 250;

	async function enqueueText(chatId: string, text: string): Promise<void> {
		const batch = sendQueue.get(chatId) ?? [];
		batch.push(text);
		sendQueue.set(chatId, batch);
		if (draining) return;
		draining = true;
		try {
			while (sendQueue.size > 0) {
				await new Promise((r) => setTimeout(r, sendSpacingMs));
				for (const [qid, items] of [...sendQueue.entries()]) {
					sendQueue.delete(qid);
					try {
						const thread = await threadFor(qid);
						await thread.post(items.join("\n"));
					} catch (error) {
						options.logger.warn("coalesced send failed", { chatId: qid, error: (error as Error).message });
					}
				}
			}
		} finally {
			draining = false;
		}
	}

	return {
		onMessage(cb) {
			messageCb = cb;
		},
		async post(chatId, chunks, done, threadId = "") {
			const thread = await threadFor(chatId, threadId);
			let full = "";
			try {
				const wrapped = (async function* () {
					for await (const chunk of throttled(chunks)) {
						full += chunk;
						yield chunk;
					}
				})();
				await thread.post(wrapped);
				return true;
			} catch (error) {
				options.logger.error("stream post failed; falling back to plain text", {
					chatId,
					error: (error as Error).message,
				});
				// Degraded path: one plain message with whatever accumulated (P0-3.3).
				try {
					if (full.length > 0) await thread.post(full.slice(0, 4000));
					else await thread.post("⚠️ 回复发送失败，请重试。");
					return true;
				} catch {
					return false;
				}
			} finally {
				done?.(full);
			}
		},
		async postText(chatId, text) {
			await enqueueText(chatId, text);
		},
		async postCard(chatId, card) {
			const thread = await threadFor(chatId);
			await thread.post(buildApprovalCard(card));
		},
		onCardAction(cb) {
			cardCb = cb;
		},
		backfill: (chatId, since) => backfillChat(runner, options, chatId, since),
		start: () => bot.initialize(),
		stop: async () => {
			merger.flushAll(); // admit anything still inside the burst window
			await bot.shutdown();
		},
	};
}

// ---------------------------------------------------------------------------
// Backfill via lark-cli (F08 / P0-3.4, r2-verified flags)
// ---------------------------------------------------------------------------

interface LarkCliMessage {
	message_id?: string;
	chat_id?: string;
	root_id?: string;
	msg_type?: string;
	create_time?: string;
	sender?: { sender_type?: string; id?: string };
	body?: { content?: string };
}

/** `--start` = watermark truncated to seconds minus 1s: overlap beats gaps (P0-3.4). */
export function backfillStartArg(sinceMs: number): string {
	const truncated = Math.floor(sinceMs / 1000) * 1000 - 1000;
	return new Date(truncated).toISOString();
}

export async function backfillChat(
	runner: CommandRunner,
	options: ChannelOptions,
	chatId: string,
	since: Date,
): Promise<InboundMessage[]> {
	const out: InboundMessage[] = [];
	let pageToken: string | undefined;
	do {
		const args = [
			"im",
			"+chat-messages-list",
			"--as",
			"bot",
			"--chat-id",
			chatId,
			"--start",
			backfillStartArg(since.getTime()),
			"--no-reactions",
			"--sort",
			"asc",
		];
		if (pageToken) args.push("--page-token", pageToken);
		let payload: { items?: LarkCliMessage[]; page_token?: string; has_more?: boolean };
		try {
			const { stdout } = await runner(options.larkCliPath, args);
			payload = JSON.parse(stdout);
		} catch (error) {
			options.logger.warn("backfill command failed", { chatId, error: (error as Error).message });
			return out; // Partial result: duplicates upstream make retry safe.
		}
		for (const item of payload.items ?? []) {
			// Bot's own messages (sender_type "app") are never input.
			if (item.sender?.sender_type === "app") continue;
			if (!item.message_id || !item.chat_id) continue;
			out.push({
				chatId: item.chat_id,
				messageId: item.message_id,
				text: extractText(item),
				senderId: item.sender?.id ?? "",
				isMention: false, // history list does not carry mention flags
				isBot: item.sender?.sender_type !== "user",
				sentAt: item.create_time ? Number(item.create_time) : since.getTime(),
			});
		}
		pageToken = payload.page_token;
		if (out.length > 500) break; // safety valve for a huge catch-up window
	} while (pageToken);
	return out;
}

function extractText(item: LarkCliMessage): string {
	if (item.msg_type !== "text") return `[${item.msg_type ?? "unknown"}]`;
	try {
		const parsed = JSON.parse(item.body?.content ?? "{}") as { text?: string };
		return parsed.text ?? "";
	} catch {
		return "";
	}
}
