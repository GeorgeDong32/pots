import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { ApprovalManager } from "../src/approvals.ts";
import { callDigest, createApprovalGateExtension } from "../src/durable-ext/approval-gate.ts";
import { SessionApprovalsDoc, sessionApprovalKey } from "../src/durable-ext/docs.ts";
import type { CardAction, Channel, InboundMessage } from "../src/channel.ts";
import { createLogger } from "../src/log.ts";
import type { Substrate } from "../src/substrate.ts";
import { openTestSubstrate } from "./helpers-p1.ts";

const logger = createLogger("error", () => undefined);
const OWNER = "ou_owner";

/** Records cards and text; card clicks are driven by the test. */
class ApprovalChannel implements Channel {
	cards: Array<{ chatId: string; approvalId: string; toolName: string }> = [];
	texts: string[] = [];
	posted: { chatId: string; full: string }[] = [];
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
	async postCard(chatId: string, card: { approvalId: string; toolName: string }): Promise<void> {
		this.cards.push({ chatId, approvalId: card.approvalId, toolName: card.toolName });
	}
	async backfill(): Promise<InboundMessage[]> {
		return [];
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	deliver(m: InboundMessage): void {
		this.messageCb?.(m);
	}
	click(manager: ApprovalManager, actionId: string, approvalId: string, operator: string): Promise<void> {
		return manager.onCardAction({ actionId, value: approvalId, operatorOpenId: operator, chatId: "oc_home", messageId: "" });
	}
}

/** A dangerous tool that records its executions. */
function dangerousTool(spy: string[]) {
	return defineTool({
		name: "write_file",
		description: "writes a file (dangerous, approval required)",
		parameters: obj({ path: str(), content: opt(str()) }),
		execute: async (args) => {
			spy.push(args.path);
			return { output: [{ type: "text", text: `wrote ${args.path}` }] };
		},
	});
}

const closed: Substrate[] = [];
afterEach(async () => {
	for (const s of closed.splice(0)) await s.close().catch(() => undefined);
});

async function setup(timeoutMs?: number) {
	const spy: string[] = [];
	const channel = new ApprovalChannel();
	const manager = new ApprovalManager({ channel, ownerOpenId: OWNER, logger, timeoutMs });
	const ext = defineExtension({ name: "test-danger", tools: [dangerousTool(spy)] });
	const { substrate, faux } = await openTestSubstrate({
		homeChatId: "oc_home",
		ownerOpenId: OWNER,
		extraExtensions: [createApprovalGateExtension(manager), ext],
	});
	closed.push(substrate);
	manager.attach(substrate);
	return { substrate, faux, manager, channel, spy };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

describe("M5 approval flow (P1-3)", () => {
	it("deny blocks the tool; the run continues with a blocked result", async () => {
		const { substrate, faux, manager, channel, spy } = await setup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "/tmp/a.txt", content: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("blocked then answered"),
		]);
		const conv = await substrate.root();
		const sub = await substrate.submit(conv, { type: "input", content: "go", requestId: "feishu:ap1" });
		void sub.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		await waitFor(() => channel.cards.length === 1);
		const approvalId = channel.cards[0]?.approvalId as string;
		await channel.click(manager, "deny", approvalId, OWNER);
		const settled = await sub.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		expect(spy).toEqual([]); // never executed
		expect(channel.texts).toContain("❌ 已拒绝");
	});

	it("approve_once executes exactly this call; an identical next call asks again", async () => {
		const { substrate, faux, manager, channel, spy } = await setup();
		const call = fauxAssistantMessage([fauxToolCall("write_file", { path: "/tmp/b.txt", content: "y" })], { stopReason: "toolUse" });
		faux.setResponses([call, fauxAssistantMessage("first done")]);
		const conv = await substrate.root();
		const s1 = await substrate.submit(conv, { type: "input", content: "go", requestId: "feishu:ap2" });
		void s1.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		await waitFor(() => channel.cards.length === 1);
		await channel.click(manager, "approve_once", channel.cards[0]?.approvalId as string, OWNER);
		await s1.wait(BACKGROUND_CONTEXT);
		expect(spy).toEqual(["/tmp/b.txt"]);

		faux.setResponses([call, fauxAssistantMessage("second done")]);
		const s2 = await substrate.submit(conv, { type: "input", content: "again", requestId: "feishu:ap3" });
		void s2.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		await waitFor(() => channel.cards.length === 2); // once ≠ session: asked again
		await channel.click(manager, "approve_once", channel.cards[1]?.approvalId as string, OWNER);
		await s2.wait(BACKGROUND_CONTEXT);
		expect(spy).toEqual(["/tmp/b.txt", "/tmp/b.txt"]);
	});

	it("Always (approve_session) lets the exact same command pass for 4h; different args still ask (F21)", async () => {
		const { substrate, faux, manager, channel, spy } = await setup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "/tmp/c.txt", content: "1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done1"),
		]);
		const conv = await substrate.root();
		const s1 = await substrate.submit(conv, { type: "input", content: "go", requestId: "feishu:ap4" });
		void s1.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		await waitFor(() => channel.cards.length === 1);
		await channel.click(manager, "approve_session", channel.cards[0]?.approvalId as string, OWNER);
		await s1.wait(BACKGROUND_CONTEXT);
		expect(spy).toEqual(["/tmp/c.txt"]);

		// Identical call: no card, straight through.
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "/tmp/c.txt", content: "1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done2"),
		]);
		const s2 = await substrate.submit(conv, { type: "input", content: "same", requestId: "feishu:ap5" });
		const settled2 = await s2.wait(BACKGROUND_CONTEXT);
		expect(settled2.status).toBe("done");
		expect(channel.cards.length).toBe(1); // no second card
		expect(spy).toEqual(["/tmp/c.txt", "/tmp/c.txt"]);

		// Different args (exact-string rule): asks again.
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "/tmp/OTHER.txt", content: "1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done3"),
		]);
		const s3 = await substrate.submit(conv, { type: "input", content: "other", requestId: "feishu:ap6" });
		void s3.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		await waitFor(() => channel.cards.length === 2);
		await channel.click(manager, "deny", channel.cards[1]?.approvalId as string, OWNER);
		await s3.wait(BACKGROUND_CONTEXT);
		expect(spy).toEqual(["/tmp/c.txt", "/tmp/c.txt"]);
	});

	it("non-owner clicks are audited and ignored; the owner can still decide (F03/B4)", async () => {
		const { substrate, faux, manager, channel, spy } = await setup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "/tmp/d.txt", content: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const conv = await substrate.root();
		const sub = await substrate.submit(conv, { type: "input", content: "go", requestId: "feishu:ap7" });
		void sub.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		await waitFor(() => channel.cards.length === 1);
		const approvalId = channel.cards[0]?.approvalId as string;
		await channel.click(manager, "approve_once", approvalId, "ou_attacker");
		await new Promise((r) => setTimeout(r, 80));
		expect(spy).toEqual([]); // attacker's click did nothing
		const state = await substrate.getApproval(approvalId);
		expect(state?.status).toBe("pending");
		await channel.click(manager, "approve_once", approvalId, OWNER);
		await sub.wait(BACKGROUND_CONTEXT);
		expect(spy).toEqual(["/tmp/d.txt"]);
	});

	it("sensitive paths are refused without any card (P1-3.1)", async () => {
		const { substrate, faux, channel, spy } = await setup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "/Users/x/.ssh/id_rsa", content: "steal" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const conv = await substrate.root();
		const sub = await substrate.submit(conv, { type: "input", content: "go", requestId: "feishu:ap8" });
		const settled = await sub.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		expect(spy).toEqual([]);
		expect(channel.cards.length).toBe(0); // hard refusal never enters approval
	});

	it("timeout sweep denies a pending approval (P1-3.3.4)", async () => {
		const { substrate, faux, manager, channel, spy } = await setup(80);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "/tmp/e.txt", content: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const conv = await substrate.root();
		const sub = await substrate.submit(conv, { type: "input", content: "go", requestId: "feishu:ap9" });
		void sub.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		await waitFor(() => channel.cards.length === 1);
		await new Promise((r) => setTimeout(r, 150));
		await manager.sweep();
		const settled = await sub.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		expect(spy).toEqual([]);
		expect(channel.texts.some((t) => t.includes("超时"))).toBe(true);
	});

	it("crash re-entry: a fresh manager re-sends the SAME approvalId and honors the click (F01/F08/B5)", async () => {
		const { substrate, channel } = await setup();
		const conv = await substrate.root();
		const call = { name: "write_file", arguments: { path: "/tmp/f.txt", content: "x" }, callId: "cc1" };

		// Process A dies while the approval pends: its in-memory await is gone
		// with it; the durable pending doc is what survives.
		const managerA = new ApprovalManager({ channel, ownerOpenId: OWNER, logger });
		managerA.attach(substrate);
		void managerA.request(call, Number(conv.id)); // card 1; promise abandoned (dead process)
		await waitFor(() => channel.cards.length === 1);

		// Process B re-enters beforeTool with the identical call: same id, card re-sent (F08).
		const managerB = new ApprovalManager({ channel, ownerOpenId: OWNER, logger });
		managerB.attach(substrate);
		const decision = managerB.request(call, Number(conv.id));
		await waitFor(() => channel.cards.length === 2);
		expect(channel.cards[1]?.approvalId).toBe(channel.cards[0]?.approvalId); // SAME approvalId

		await channel.click(managerB, "approve_once", channel.cards[1]?.approvalId as string, OWNER);
		expect((await decision).allow).toBe(true);
		const state = await substrate.getApproval(channel.cards[1]?.approvalId as string);
		expect(state?.status).toBe("approved_once");
	});

	it("an expired Always grant asks again instead of staying allowed", async () => {
		const { substrate, faux, manager, channel } = await setup();
		const args = { path: "/tmp/ttl.txt", content: "1" };
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done1"),
		]);
		const conv = await substrate.root();
		const s1 = await substrate.submit(conv, { type: "input", content: "go", requestId: "feishu:ap-ttl-1" });
		void s1.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		await waitFor(() => channel.cards.length === 1);
		await channel.click(manager, "approve_session", channel.cards[0]?.approvalId as string, OWNER);
		await s1.wait(BACKGROUND_CONTEXT);

		const key = sessionApprovalKey(Number(conv.id), "write_file", callDigest({ name: "write_file", arguments: args, callId: "ttl" }));
		await substrate.commit(async (tx) => {
			const doc = await tx.doc(SessionApprovalsDoc, key, key);
			doc.expiresAt = 1;
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done2"),
		]);
		const s2 = await substrate.submit(conv, { type: "input", content: "again", requestId: "feishu:ap-ttl-2" });
		void s2.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		await waitFor(() => channel.cards.length === 2);
		await channel.click(manager, "deny", channel.cards[1]?.approvalId as string, OWNER);
		await s2.wait(BACKGROUND_CONTEXT);
		expect(channel.cards.length).toBe(2);
	});
});
