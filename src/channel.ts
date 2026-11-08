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
	encodeThreadId,
} from "@larksuite/vercel-chat-adapter";
import type { Logger } from "./log.js";

const execFileAsync = promisify(execFile);

export interface InboundMessage {
	chatId: string;
	messageId: string;
	text: string;
	senderId: string;
	isMention: boolean;
	isBot: boolean;
	sentAt: number; // Lark server epoch ms when known, else Date.now()
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
	/** Stream a reply into a chat as one card; `done` gets the full text once the stream closes. */
	post(chatId: string, chunks: AsyncIterable<string>, done?: (full: string) => void): Promise<void>;
	/** Post a plain one-shot text message (notices, escalations). */
	postText(chatId: string, text: string): Promise<void>;
	onCardAction(cb: (a: CardAction) => void): void;
	/** Read messages a disconnect window may have missed; duplicates are absorbed upstream. */
	backfill(chatId: string, since: Date): Promise<InboundMessage[]>;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface ChannelOptions {
	appId: string;
	appSecret: string;
	botName: string;
	larkCliPath: string;
	logger: Logger;
	/** Minimum interval between streamed chunks (F17: card 10 QPS headroom). */
	minChunkIntervalMs?: number;
}

/** Injectable process runner so tests can stub lark-cli. */
export type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;
export const defaultRunner: CommandRunner = async (file, args) => execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 });

export function createChannel(options: ChannelOptions, runner: CommandRunner = defaultRunner): Channel {
	const minInterval = options.minChunkIntervalMs ?? 200;
	let messageCb: ((m: InboundMessage) => void) | undefined;
	let cardCb: ((a: CardAction) => void) | undefined;

	const bot = new Chat({
		userName: options.botName,
		adapters: { lark: createLarkAdapter({ appId: options.appId, appSecret: options.appSecret }) },
		state: createMemoryState(),
		concurrency: "queue",
	});

	/** Most recent live thread per chat, so replies land in the right context. */
	const threads = new Map<string, Thread>();

	function rememberThread(chatId: string, thread: Thread): void {
		threads.set(chatId, thread);
		// Bound the cache; one thread per chat is all we need.
		if (threads.size > 100) threads.delete(threads.keys().next().value as string);
	}

	async function threadFor(chatId: string): Promise<Thread> {
		const live = threads.get(chatId);
		if (live) return live;
		// No inbound yet: address the chat directly (empty root = top-level post).
		return bot.thread(encodeThreadId({ chatId, rootId: "" }));
	}

	function dispatch(thread: Thread, message: Message): void {
		const chatId = channelIdFromThreadId(message.threadId);
		rememberThread(chatId, thread);
		const inbound: InboundMessage = {
			chatId,
			messageId: message.id,
			text: message.text,
			senderId: message.author.userId ?? "",
			isMention: message.isMention === true,
			isBot: message.author.isBot === true,
			sentAt: Date.now(),
		};
		messageCb?.(inbound);
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

	return {
		onMessage(cb) {
			messageCb = cb;
		},
		async post(chatId, chunks, done) {
			const thread = await threadFor(chatId);
			let full = "";
			try {
				const wrapped = (async function* () {
					for await (const chunk of throttled(chunks)) {
						full += chunk;
						yield chunk;
					}
				})();
				await thread.post(wrapped);
			} catch (error) {
				options.logger.error("stream post failed; falling back to plain text", {
					chatId,
					error: (error as Error).message,
				});
				// Degraded path: one plain message with whatever accumulated (P0-3.3).
				if (full.length > 0) await thread.post(full.slice(0, 4000));
				else await thread.post("⚠️ 回复发送失败，请重试。");
			} finally {
				done?.(full);
			}
		},
		async postText(chatId, text) {
			const thread = await threadFor(chatId);
			await thread.post(text);
		},
		onCardAction(cb) {
			cardCb = cb;
		},
		backfill: (chatId, since) => backfillChat(runner, options, chatId, since),
		start: () => bot.initialize(),
		stop: () => bot.shutdown(),
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
