import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createMemoryExtension } from "../src/durable-ext/memory-ext.ts";
import type { Substrate } from "../src/substrate.ts";
import { openTestSubstrate } from "./helpers-p1.ts";

let home: string | undefined;
const closed: Substrate[] = [];
const realHome = process.env.HOME;

beforeEach(() => {
	home = join(tmpdir(), `pi-larkd-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(home, ".pi-larkd", "memory"), { recursive: true });
	process.env.HOME = home;
});

afterEach(async () => {
	for (const s of closed.splice(0)) await s.close().catch(() => undefined);
	if (home) rmSync(home, { recursive: true, force: true });
	if (realHome) process.env.HOME = realHome;
});

async function setup(extra: { v1?: boolean } = {}) {
	const agentHome = join(home as string, ".pi-larkd");
	const { substrate, faux } = await openTestSubstrate({
		homeChatId: "oc_home",
		ownerOpenId: "ou_owner",
		extraExtensions: [
			createMemoryExtension({
				agentHome,
				v1: extra.v1
					? {
							indexHeader: (cwd, maxBytes) => indexHeaderFor(cwd, maxBytes),
							recall: async () => "recall-result",
							consolidate: async () => "consolidate-result",
							overBudget: () => [],
						}
					: undefined,
			}),
		],
	});
	closed.push(substrate);
	return { substrate, faux, agentHome };
}

async function indexHeaderFor(_cwd: string, maxBytes: number): Promise<string> {
	return "stub".slice(0, maxBytes);
}

/** The pi.system entry's sections record carries rendered section text. */
async function sectionText(substrate: Substrate, conversationId: number): Promise<Record<string, string>> {
	return await substrate.commit(async (tx) => {
		const page = await tx.scanEntries({ conversationId: conversationId as never, order: "descending" }, 20, undefined);
		for (const entry of page.items) {
			if (entry.kind === "pi.system") {
				const model = entry.model?.[0] as { sections?: Record<string, string> } | undefined;
				if (model?.sections) return model.sections;
			}
		}
		return {};
	});
}

describe("P2 v0: memory.md two-layer injection (C1)", () => {
	it("renders shared + channel layers into the memory section", async () => {
		const { substrate, faux, agentHome } = await setup();
		writeFileSync(join(agentHome, "memory", "shared.md"), "- 部署偏好是 pnpm", "utf8");
		mkdirSync(join(agentHome, "memory", "channels"), { recursive: true });
		writeFileSync(join(agentHome, "memory", "channels", "oc_home.md"), "- 本频道在测 t3", "utf8");

		faux.setResponses([fauxAssistantMessage("ok")]);
		const conv = await substrate.root();
		const sub = await substrate.submit(conv, { type: "input", content: "hi", requestId: "feishu:c1" });
		await sub.wait(BACKGROUND_CONTEXT);

		const sections = await sectionText(substrate, Number(conv.id));
		expect(sections["memory"]).toContain("部署偏好是 pnpm");
		expect(sections["memory"]).toContain("本频道在测 t3");
	});

	it("memory_write appends server-side to the channel file of the calling conversation", async () => {
		const { substrate, faux, agentHome } = await setup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("memory_write", { text: "记住：偏好 uv" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("noted"),
		]);
		const conv = await substrate.root();
		const sub = await substrate.submit(conv, { type: "input", content: "记住：偏好 uv", requestId: "feishu:c2" });
		const settled = await sub.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		const channelFile = join(agentHome, "memory", "channels", "oc_home.md");
		expect(existsSync(channelFile)).toBe(true);
		expect(readFileSync(channelFile, "utf8")).toContain("偏好 uv");
		// v0 file persists across a daemon restart by construction (plain fs).
	});

	it("shared scope lands in shared.md", async () => {
		const { substrate, faux, agentHome } = await setup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("memory_write", { text: "全局事实", shared: true })], { stopReason: "toolUse" }),
			fauxAssistantMessage("noted"),
		]);
		const conv = await substrate.root();
		const sub = await substrate.submit(conv, { type: "input", content: "记住", requestId: "feishu:c3" });
		await sub.wait(BACKGROUND_CONTEXT);
		expect(readFileSync(join(agentHome, "memory", "shared.md"), "utf8")).toContain("全局事实");
	});
});

describe("P2 v1: cc-core semantic core (C2/C3/C4 automatable parts)", () => {
	it("session_recall tool routes through the wired deps", async () => {
		const { substrate, faux } = await setup({ v1: true });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("session_recall", { query: "部署偏好" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const conv = await substrate.root();
		const sub = await substrate.submit(conv, { type: "input", content: "recall", requestId: "feishu:c4" });
		const settled = await sub.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done"); // tool executed through the v1 deps
	});

	it("user layer indexHeader reads ~/.pi/agent/memory (shared with pi, C2)", async () => {
		// The real memcore.indexHeader (not the stub): write a user-layer file via the core format.
		const userDir = join(home as string, ".pi", "agent", "memory");
		mkdirSync(userDir, { recursive: true });
		writeFileSync(
			join(userDir, "deploy-prefs.md"),
			"---\nname: deploy-prefs\ndescription: uses pnpm\ntype: user\n---\nBody here.",
			"utf8",
		);
		const { indexHeader } = await import("../src/memcore.ts");
		const header = indexHeader(process.cwd(), 8192, home);
		expect(header).toContain("deploy-prefs");
		expect(header).toContain("uses pnpm");
		expect(header).toContain("user (shared with pi)");
	});

	it("runConsolidation under the layer lock rejects a non-shrinking batch (C4 semantics)", async () => {
		const userDir = join(home as string, ".pi", "agent", "memory");
		mkdirSync(userDir, { recursive: true });
		writeFileSync(
			join(userDir, "a.md"),
			"---\nname: a\ndescription: first\ntype: user\n---\nAAAA",
			"utf8",
		);
		const { runConsolidation } = await import("../src/memcore.ts");
		const result = runConsolidation(
			userDir,
			[{ file: "b.md", content: "---\nname: b\ndescription: second\ntype: user\n---\nBBBB" }],
			[],
			true,
		);
		expect(result.ok).toBe(false); // adds bytes without deleting: must-shrink violated
		expect(result.message).toContain("shrink");
	});

	it("a write+delete batch that shrinks applies atomically", async () => {
		const userDir = join(home as string, ".pi", "agent", "memory");
		mkdirSync(userDir, { recursive: true });
		writeFileSync(
			join(userDir, "a.md"),
			"---\nname: a\ndescription: first\ntype: user\n---\nAAAA AAAA",
			"utf8",
		);
		writeFileSync(
			join(userDir, "b.md"),
			"---\nname: b\ndescription: second\ntype: user\n---\nBBBB",
			"utf8",
		);
		const { runConsolidation } = await import("../src/memcore.ts");
		const result = runConsolidation(
			userDir,
			[
				{
					file: "a.md",
					content: "---\nname: a\ndescription: merged\ntype: user\n---\nAAAA+B",
				},
			],
			[{ file: "b.md", reason: "merged into a" }],
			true,
		);
		expect(result.ok).toBe(true);
		expect(existsSync(join(userDir, "b.md"))).toBe(false);
	});
});
