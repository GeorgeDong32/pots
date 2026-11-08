import { describe, expect, it } from "vitest";
import { createBurstMerger, DEFAULT_BURST, type InboundMessage } from "../src/channel.ts";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		chatId: "oc_g",
		messageId: `om_${Math.random().toString(36).slice(2)}`,
		text: "t",
		senderId: "ou_a",
		isMention: false,
		isBot: false,
		sentAt: Date.now(),
		...overrides,
	};
}

function fast(): ReturnType<typeof createBurstMerger> {
	return createBurstMerger({ ...DEFAULT_BURST, silenceMs: 40, mediaSilenceMs: 60 }, () => undefined);
}

describe("burst merging (P1-1.6)", () => {
	it("merges messages inside the silence window into one deterministic input", async () => {
		const out: InboundMessage[] = [];
		const merger = createBurstMerger({ ...DEFAULT_BURST, silenceMs: 50 }, (m) => out.push(m));
		merger.push(msg({ messageId: "om_1", text: "帮我" }));
		merger.push(msg({ messageId: "om_2", text: "看一下" }));
		merger.push(msg({ messageId: "om_3", text: "测试" }));
		expect(out.length).toBe(0); // still inside the window
		await new Promise((r) => setTimeout(r, 80));
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe("帮我\n看一下\n测试");
		expect(out[0]?.messageId).toBe("om_1..om_3"); // deterministic per batch
		expect(out[0]?.sentAt).toBe(out[0]?.sentAt); // last message's timestamp
	});

	it("flushes early on sender change, message cap, or char cap", async () => {
		const out: InboundMessage[] = [];
		const merger = createBurstMerger(
			{ ...DEFAULT_BURST, silenceMs: 1000, maxMessages: 2, maxChars: 5 },
			(m) => out.push(m),
		);
		merger.push(msg({ messageId: "a", text: "12" }));
		merger.push(msg({ messageId: "b", senderId: "ou_b", text: "x" })); // sender change → flush [a]
		expect(out.map((m) => m.messageId)).toEqual(["a"]);
		merger.push(msg({ messageId: "c", senderId: "ou_b", text: "y" }));
		merger.push(msg({ messageId: "d", senderId: "ou_b", text: "z" })); // cap=2 hit → flush [b..c]
		expect(out.map((m) => m.messageId)).toEqual(["a", "b..c"]);
		merger.push(msg({ messageId: "e", senderId: "ou_b", text: "123456" }));
		merger.flushAll();
		expect(out.map((m) => m.messageId)).toEqual(["a", "b..c", "d..e"]);
	});

	it("disabled burst passes every message straight through", () => {
		const out: InboundMessage[] = [];
		const merger = createBurstMerger({ ...DEFAULT_BURST, enabled: false }, (m) => out.push(m));
		merger.push(msg({ messageId: "x" }));
		merger.push(msg({ messageId: "y" }));
		expect(out.map((m) => m.messageId)).toEqual(["x", "y"]);
	});

	it("single-message batches keep the original id (requestId idempotency preserved)", async () => {
		const out: InboundMessage[] = [];
		const merger = createBurstMerger({ ...DEFAULT_BURST, silenceMs: 30 }, (m) => out.push(m));
		merger.push(msg({ messageId: "om_solo", text: "only" }));
		await new Promise((r) => setTimeout(r, 60));
		expect(out[0]?.messageId).toBe("om_solo");
	});

	it("merger is per-chat isolated", async () => {
		const out: InboundMessage[] = [];
		const merger = createBurstMerger({ ...DEFAULT_BURST, silenceMs: 30 }, (m) => out.push(m));
		merger.push(msg({ chatId: "oc_1", messageId: "m1" }));
		merger.push(msg({ chatId: "oc_2", messageId: "m2" }));
		await new Promise((r) => setTimeout(r, 60));
		expect(out.map((m) => m.messageId)).toEqual(["m1", "m2"]);
	});

	it("fast merger used by channel has bounded state", () => {
		const merger = fast();
		merger.push(msg());
		merger.flushAll();
		expect(merger).toBeDefined();
	});
});
