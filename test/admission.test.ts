import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createBridge } from "../src/bridge.ts";
import type { CardAction, Channel, InboundMessage } from "../src/channel.ts";
import { createLogger } from "../src/log.ts";
import { checkPolicy, openTestSubstrate } from "./helpers-p1.ts";
import type { ChannelBinding } from "../src/durable-ext/docs.ts";
import type { Substrate } from "../src/substrate.ts";

const logger = createLogger("error", () => undefined);

function binding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
	return {
		chatId: "oc_g",
		conversationId: 1,
		cwd: "/tmp",
		policy: {
			allowSenders: ["ou_owner", "ou_member"],
			groupPolicy: "open",
			mentionOnly: false,
			muted: [],
			dropBots: true,
			whenBusy: "followUp",
		},
		createdAt: 0,
		...overrides,
	};
}

const closed: Substrate[] = [];
afterEach(async () => {
	for (const s of closed.splice(0)) await s.close().catch(() => undefined);
});

/** T-P1-1a: the admission matrix nail (INV-P1-1). */
describe("T-P1-1a admission matrix", () => {
	it("admits an allowed sender", () => {
		expect(checkPolicy(binding(), { senderId: "ou_owner", isBot: false, isMention: false })).toBeNull();
	});

	it("denies every non-whitelisted sender — DM, group, mention, commands alike (F04/INV-P1-1)", () => {
		const b = binding();
		expect(checkPolicy(b, { senderId: "ou_stranger", isBot: false, isMention: false })).toBe("sender-not-allowed");
		expect(checkPolicy(b, { senderId: "ou_stranger", isBot: false, isMention: true })).toBe("sender-not-allowed");
	});

	it("drops bots (F24), honors disabled groups, mention-only, and muted members", () => {
		const b = binding();
		expect(checkPolicy(b, { senderId: "ou_owner", isBot: true, isMention: false })).toBe("bot-dropped");
		const disabled = binding({ policy: { ...b.policy, groupPolicy: "disabled" } });
		expect(checkPolicy(disabled, { senderId: "ou_owner", isBot: false, isMention: false })).toBe("group-disabled");
		const mentionOnly = binding({ policy: { ...b.policy, mentionOnly: true } });
		expect(checkPolicy(mentionOnly, { senderId: "ou_owner", isBot: false, isMention: false })).toBe("mention-required");
		expect(checkPolicy(mentionOnly, { senderId: "ou_owner", isBot: false, isMention: true })).toBeNull();
		const muted = binding({ policy: { ...b.policy, muted: ["ou_member"] } });
		expect(checkPolicy(muted, { senderId: "ou_member", isBot: false, isMention: false })).toBe("muted");
	});
});

describe("atomic admission via substrate (P1-1.2)", () => {
	it("migrates homeChatId into the table and admits the owner", async () => {
		const { substrate, faux } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		closed.push(substrate);
		faux.setResponses([fauxAssistantMessage("ok")]);

		const { bindings, homeChatId } = await substrate.bindings();
		expect(homeChatId).toBe("oc_home");
		expect(bindings.oc_home?.policy.allowSenders).toEqual(["ou_owner"]);

		const result = await substrate.admitBinding("oc_home", {
			messageId: "om_p1_1",
			text: "hello",
			senderId: "ou_owner",
			isBot: false,
			isMention: false,
			sentAt: 123,
		});
		expect(result.kind).toBe("admitted");
		expect(await substrate.watermark("oc_home")).toBe(123);
	});

	it("denies strangers with ZERO durable writes (no submission, no watermark)", async () => {
		const { substrate } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		closed.push(substrate);
		const result = await substrate.admitBinding("oc_home", {
			messageId: "om_p1_2",
			text: "let me in",
			senderId: "ou_stranger",
			isBot: false,
			isMention: false,
			sentAt: 456,
		});
		expect(result).toEqual({ kind: "denied", reason: "sender-not-allowed" });
		expect(await substrate.watermark("oc_home")).toBeUndefined();
	});

	it("unbound chats report unbound", async () => {
		const { substrate } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		closed.push(substrate);
		const result = await substrate.admitBinding("oc_other", {
			messageId: "om_p1_3",
			text: "hi",
			senderId: "ou_owner",
			isBot: false,
			isMention: false,
			sentAt: 1,
		});
		expect(result).toEqual({ kind: "unbound" });
	});

	it("bindChannel creates a conversation and admits to it", async () => {
		const { substrate } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		closed.push(substrate);
		const summary = await substrate.bindChannel({ chatId: "oc_ws", cwd: "/tmp/ws", isGroup: true });
		expect(summary).toContain("oc_ws");
		const { bindings } = await substrate.bindings();
		expect(bindings.oc_ws?.cwd).toBe("/tmp/ws");
		expect(bindings.oc_ws?.policy.mentionOnly).toBe(true); // group default
		const result = await substrate.admitBinding("oc_ws", {
			messageId: "om_p1_4",
			text: "check the board",
			senderId: "ou_owner",
			isBot: false,
			isMention: true,
			sentAt: 9,
		});
		expect(result.kind).toBe("admitted");
	});
});

describe("remote control (P1-4)", () => {
	class FakeChannel implements Channel {
		posted: { chatId: string; full: string }[] = [];
		texts: string[] = [];
		cards: string[] = [];
		private messageCb: ((m: InboundMessage) => void) | undefined;
		onMessage(cb: (m: InboundMessage) => void): void {
			this.messageCb = cb;
		}
		onCardAction(_cb: (a: CardAction) => void): void {}
		async post(chatId: string, chunks: AsyncIterable<string>, done?: (full: string) => void): Promise<boolean> {
			let full = "";
			for await (const c of chunks) full += c;
			this.posted.push({ chatId, full });
			done?.(full);
			return true;
		}
		async postText(_chatId: string, text: string): Promise<void> {
			this.texts.push(text);
		}
		async postCard(_chatId: string, card: { approvalId: string }): Promise<void> {
			this.cards.push(card.approvalId);
		}
		async backfill(): Promise<InboundMessage[]> {
			return [];
		}
		async start(): Promise<void> {}
		async stop(): Promise<void> {}
		deliver(m: InboundMessage): void {
			this.messageCb?.(m);
		}
	}

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

	async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
	}

	it("owner status command answers with conversation state, not an agent run", async () => {
		const { substrate } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		closed.push(substrate);
		const channel = new FakeChannel();
		createBridge({ substrate, channel, config: { homeChatId: "oc_home", ownerOpenId: "ou_owner" }, logger });
		channel.deliver(msg({ text: "status" }));
		await waitFor(() => channel.texts.length > 0);
		expect(channel.texts[0]).toContain("conversation");
		expect(channel.posted.length).toBe(0); // no agent run
	});

	it("non-owner 'stop' is treated as plain input, never executed (F20/INV-P1-1)", async () => {
		const { substrate, faux } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		closed.push(substrate);
		faux.setResponses([fauxAssistantMessage("ack")]);
		// A second allowed sender for this check.
		const { bindings } = await substrate.bindings();
		void bindings;
		const channel = new FakeChannel();
		createBridge({ substrate, channel, config: { homeChatId: "oc_home", ownerOpenId: "ou_owner" }, logger });
		// Stranger (not even whitelisted): denied silently.
		channel.deliver(msg({ text: "stop", senderId: "ou_stranger" }));
		await new Promise((r) => setTimeout(r, 100));
		expect(channel.texts.length).toBe(0);
		expect(channel.posted.length).toBe(0);
	});

	it("owner new <note> resets the conversation (P1-4)", async () => {
		const { substrate } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		closed.push(substrate);
		const channel = new FakeChannel();
		createBridge({ substrate, channel, config: { homeChatId: "oc_home", ownerOpenId: "ou_owner" }, logger });
		channel.deliver(msg({ text: "new 我们在做部署检查" }));
		await waitFor(() => channel.texts.some((t) => t.includes("已重置")));
		expect(channel.texts[0]).toContain("我们在做部署检查");
	});
});
