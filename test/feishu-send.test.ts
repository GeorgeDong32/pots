import { describe, expect, it } from "vitest";
import { feishuSendCommand } from "../src/feishu-send.ts";

describe("Feishu HTTP send", () => {
	it("sends chat text through lark-cli without opening a websocket", () => {
		const command = feishuSendCommand({
			bin: "lark-cli",
			chatId: "oc_target",
			text: "hello",
			idempotencyKey: "routine:job:1:oc_target",
		});
		expect(command.file).toBe("lark-cli");
		expect(command.args).toEqual([
			"im", "+messages-send", "--as", "bot",
			"--chat-id", "oc_target",
			"--text", "hello",
			"--idempotency-key", "routine:job:1:oc_target",
		]);
	});

	it("replies inside a thread when the deliver target is a message id", () => {
		const command = feishuSendCommand({
			bin: "lark-cli",
			chatId: "oc_target",
			threadId: "om_root",
			text: "hello",
		});
		expect(command.args.slice(0, 6)).toEqual([
			"im", "+messages-reply", "--as", "bot", "--message-id", "om_root",
		]);
		expect(command.args).toContain("--reply-in-thread");
	});
});
