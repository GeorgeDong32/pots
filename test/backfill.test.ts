import { describe, expect, it } from "vitest";
import { backfillChat, backfillStartArg, type ChannelOptions, type CommandRunner } from "../src/channel.ts";
import { createLogger } from "../src/log.ts";

const logger = createLogger("error", () => undefined);

const channelOptions: ChannelOptions = {
	appId: "cli_test",
	appSecret: "secret",
	botName: "test",
	larkCliPath: "/usr/local/bin/lark-cli",
	logger,
	minChunkIntervalMs: 0,
};

describe("backfillStartArg (P0-3.4 watermark semantics)", () => {
	it("truncates to seconds and backs off 1s: overlap beats gaps", () => {
		// 12:00:00.500Z -> floor to 12:00:00.000 -> minus 1s = 11:59:59.000Z
		expect(backfillStartArg(Date.parse("2026-11-08T12:00:00.500Z"))).toBe("2026-11-08T11:59:59.000Z");
		expect(backfillStartArg(Date.parse("2026-11-08T12:00:00.000Z"))).toBe("2026-11-08T11:59:59.000Z");
		expect(backfillStartArg(Date.parse("2026-11-08T11:59:59.999Z"))).toBe("2026-11-08T11:59:58.000Z");
	});
});

describe("backfillChat via lark-cli (F08)", () => {
	it("issues the verified command shape and pages through results", async () => {
		const calls: string[][] = [];
		const runner: CommandRunner = async (_file, args) => {
			calls.push(args);
			if (calls.length === 1) {
				return {
					stdout: JSON.stringify({
						items: [
							{
								message_id: "om_1",
								chat_id: "oc_home",
								msg_type: "text",
								create_time: "1730000000000",
								sender: { sender_type: "user", id: "ou_a" },
								body: { content: '{"text":"hello"}' },
							},
							{
								message_id: "om_bot",
								chat_id: "oc_home",
								msg_type: "text",
								create_time: "1730000001000",
								sender: { sender_type: "app", id: "cli_bot" },
								body: { content: '{"text":"bot self"}' },
							},
						],
						page_token: "tok2",
						has_more: true,
					}),
				};
			}
			return {
				stdout: JSON.stringify({
					items: [
						{
							message_id: "om_2",
							chat_id: "oc_home",
							msg_type: "text",
							create_time: "1730000002000",
							sender: { sender_type: "user", id: "ou_b" },
							body: { content: '{"text":"world"}' },
						},
					],
				}),
			};
		};

		const out = await backfillChat(runner, channelOptions, "oc_home", new Date(Date.parse("2026-11-08T12:00:00Z")));

		expect(calls.length).toBe(2);
		const first = calls[0] as string[];
		expect(first).toContain("im");
		expect(first).toContain("+chat-messages-list");
		expect(first).toContain("--as");
		expect(first).toContain("bot");
		expect(first).toContain("--chat-id");
		expect(first).toContain("oc_home");
		expect(first).toContain("--no-reactions");
		expect(first).toContain("--sort");
		expect(first).toContain("asc");
		const startIdx = first.indexOf("--start");
		expect(first[startIdx + 1]).toBe("2026-11-08T11:59:59.000Z");
		expect((calls[1] as string[]).includes("--page-token")).toBe(true);

		// Bot's own message filtered; user messages kept with parsed text.
		expect(out.map((m) => m.messageId)).toEqual(["om_1", "om_2"]);
		expect(out[0]?.text).toBe("hello");
		expect(out[0]?.senderId).toBe("ou_a");
		expect(out[0]?.sentAt).toBe(1730000000000);
		expect(out[1]?.text).toBe("world");
	});

	it("returns partial results when lark-cli fails (retry is safe: requestId dedup upstream)", async () => {
		const runner: CommandRunner = async () => {
			throw new Error("boom");
		};
		const out = await backfillChat(runner, channelOptions, "oc_home", new Date());
		expect(out).toEqual([]);
	});
});
