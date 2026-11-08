import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createBridge } from "../src/bridge.js";
import type { CardAction, Channel, InboundMessage } from "../src/channel.js";
import { createLogger } from "../src/log.js";
import { openTestSubstrate } from "./helpers-p1.js";

class FakeChannel implements Channel {
	posted: { chatId: string; full: string }[] = [];
	texts: { chatId: string; text: string }[] = [];
	cardActions: ((a: CardAction) => void)[] = [];
	private messageCb: ((m: InboundMessage) => void) | undefined;
	streams = new Map<string, (chunks: AsyncIterable<string>, done?: (full: string) => void) => Promise<void>>();

	onMessage(cb: (m: InboundMessage) => void): void {
		this.messageCb = cb;
	}
	onCardAction(cb: (a: CardAction) => void): void {
		this.cardActions.push(cb);
	}
	async post(chatId: string, chunks: AsyncIterable<string>, done?: (full: string) => void): Promise<void> {
		let full = "";
		for await (const chunk of chunks) full += chunk;
		this.posted.push({ chatId, full });
		done?.(full);
	}
	async postText(chatId: string, text: string): Promise<void> {
		this.texts.push({ chatId, text });
	}
	async postCard(_chatId: string, _card: { approvalId: string }): Promise<void> {}
	async backfill(): Promise<InboundMessage[]> {
		return [];
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	/** Test hook: deliver a message as the adapter would. */
	deliver(m: InboundMessage): void {
		this.messageCb?.(m);
	}
}

const logger = createLogger("error", () => undefined);

function msg(overrides: Partial<InboundMessage>): InboundMessage {
	return {
		chatId: "oc_home",
		messageId: `om_${Math.random().toString(36).slice(2)}`,
		text: "hi",
		senderId: "ou_owner",
		isMention: false,
		isBot: false,
		sentAt: Date.now(),
		...overrides,
	};
}


async function settlePosted(channel: FakeChannel, count: number, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (channel.posted.length < count && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe("M2 bridge routing (P0-4.4)", () => {
	it("admits messages from the home chat; the answer streams back exactly once", async () => {
		const { substrate, faux } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		faux.setResponses([fauxAssistantMessage("Hello world, this is the answer.")]);
		const channel = new FakeChannel();
		createBridge({ substrate, channel, config: { homeChatId: "oc_home", ownerOpenId: "ou_owner" }, logger });
		channel.deliver(msg({ messageId: "om_1", text: "hello" }));
		await settlePosted(channel, 1);
		expect(channel.posted.length).toBe(1);
		expect(channel.posted[0]?.full).toBe("Hello world, this is the answer.");
	});

	it("denies unbound chats with the fixed notice, with cooldown", async () => {
		const { substrate } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		const channel = new FakeChannel();
		createBridge({ substrate, channel, config: { homeChatId: "oc_home", ownerOpenId: "ou_owner" }, logger });
		channel.deliver(msg({ chatId: "oc_stranger", messageId: "om_s1" }));
		channel.deliver(msg({ chatId: "oc_stranger", messageId: "om_s2" }));
		await new Promise((r) => setTimeout(r, 100));
		expect(channel.texts.length).toBe(1); // cooldown suppressed the second
		expect(channel.texts[0]?.chatId).toBe("oc_stranger");
		expect(channel.texts[0]?.text).toContain("未绑定");
		expect(channel.posted.length).toBe(0);
	});

	it("drops bot messages silently", async () => {
		const { substrate } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		const channel = new FakeChannel();
		createBridge({ substrate, channel, config: { homeChatId: "oc_home", ownerOpenId: "ou_owner" }, logger });
		channel.deliver(msg({ isBot: true, messageId: "om_b" }));
		await new Promise((r) => setTimeout(r, 50));
		expect(channel.posted.length).toBe(0);
		expect(channel.texts.length).toBe(0);
	});

	it("a follow-up message replaces the pump: the second card carries the ongoing answer", async () => {
		const { substrate, faux } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		faux.setResponses([fauxAssistantMessage("first answer")]);
		const channel = new FakeChannel();
		createBridge({ substrate, channel, config: { homeChatId: "oc_home", ownerOpenId: "ou_owner" }, logger });
		channel.deliver(msg({ messageId: "om_f1", text: "q1" }));
		// While run 1 is busy, a second message queues as follow-up and takes over the pump.
		await new Promise((r) => setTimeout(r, 30));
		faux.appendResponses([fauxAssistantMessage("second answer")]);
		channel.deliver(msg({ messageId: "om_f2", text: "q2" }));
		await settlePosted(channel, 2);
		const joined = channel.posted.map((p) => p.full).join("|");
		expect(joined).toContain("first answer");
		expect(joined).toContain("second answer");
		// Both messages settled exactly once (idempotent requestIds).
		const conv = await substrate.root();
		const again = await substrate.submit(conv, {
			type: "input",
			content: "q2",
			requestId: "feishu:om_f2",
		});
		const settled = await again.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
	});
});
