/**
 * Outbound Feishu text via `lark-cli`, which talks to the Open Platform over
 * HTTP. This does not open the Chat SDK websocket.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface FeishuSend {
	chatId: string;
	threadId?: string;
	text: string;
	idempotencyKey?: string;
	bin?: string;
}

export function feishuSendCommand(input: FeishuSend): { file: string; args: string[] } {
	const file = input.bin ?? process.env.LARK_CLI ?? "lark-cli";
	const key = input.idempotencyKey;
	const thread = input.threadId;
	if (thread !== undefined && thread.startsWith("om_")) {
		const args = ["im", "+messages-reply", "--as", "bot", "--message-id", thread, "--reply-in-thread", "--text", input.text];
		if (key !== undefined) args.push("--idempotency-key", key);
		return { file, args };
	}
	const args = ["im", "+messages-send", "--as", "bot", "--chat-id", input.chatId, "--text", input.text];
	if (key !== undefined) args.push("--idempotency-key", key);
	return { file, args };
}

export async function sendFeishuMessage(input: FeishuSend): Promise<void> {
	const command = feishuSendCommand(input);
	await exec(command.file, command.args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
}
