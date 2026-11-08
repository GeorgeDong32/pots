import { afterEach, describe, expect, it } from "vitest";
import { createPatrolExtension, createPatrolTask } from "../src/durable-ext/patrol-task.js";
import type { Substrate } from "../src/substrate.js";
import { openTestSubstrate } from "./helpers-p1.js";

const closed: Substrate[] = [];
afterEach(async () => {
	for (const s of closed.splice(0)) await s.close().catch(() => undefined);
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

describe("M4 patrol task (P1-2.3)", () => {
	it("posts an escalation once per board change, then goes quiet (F11/diff-id idempotency)", async () => {
		const posts: string[] = [];
		let board = JSON.stringify({ runs: [{ name: "r1", stage: "executing" }], tasks: [] });
		const patrolTask = createPatrolTask({
			readBoard: async () => board,
			post: async (_chatId, text) => {
				posts.push(text);
			},
			summarize: (_path, content) => `stage now ${(JSON.parse(content) as { runs: { stage: string }[] }).runs[0]?.stage}`,
			intervalMs: 60,
		});
		const { substrate } = await openTestSubstrate({
			homeChatId: "oc_home",
			ownerOpenId: "ou_owner",
			extraExtensions: [createPatrolExtension(patrolTask)],
		});
		closed.push(substrate);
		await substrate.bindChannel({ chatId: "oc_ws", cwd: "/tmp/ws", boardPath: "/tmp/ws/board.json", isGroup: true });
		const created = await substrate.ensurePatrol("oc_ws", () => ({ task: patrolTask, input: { chatId: "oc_ws" } }));
		expect(created).toBe(true);
		substrate.resume();

		// First poll only records the baseline.
		await new Promise((r) => setTimeout(r, 250));
		expect(posts.length).toBe(0);

		// Change the board → exactly one escalation.
		board = JSON.stringify({ runs: [{ name: "r1", stage: "reviewing" }], tasks: [] });
		await waitFor(() => posts.length >= 1);
		await new Promise((r) => setTimeout(r, 250));
		expect(posts.length).toBe(1);
		expect(posts[0]).toContain("board 有变化");
		expect(posts[0]).toContain("reviewing");

		// Unchanged board → still quiet.
		await new Promise((r) => setTimeout(r, 250));
		expect(posts.length).toBe(1);

		// ensurePatrol is idempotent while the task lives.
		const again = await substrate.ensurePatrol("oc_ws", () => ({ task: patrolTask, input: { chatId: "oc_ws" } }));
		expect(again).toBe(false);
	});

	it("summarizeBoard produces a provenance-style summary (F27)", async () => {
		const { summarizeBoard } = await import("../src/supervisor.js");
		const summary = summarizeBoard(
			"/tmp/ws/board.json",
			JSON.stringify({
				runs: [{ name: "r1", stage: "executing" }, { name: "r2", stage: "planning" }],
				tasks: [
					{ id: "r1/t1", status: "doing" },
					{ id: "r1/t2", status: "merged" },
				],
				gates: [{ id: "g1", open: true }],
			}),
		);
		expect(summary).toContain("r1:executing");
		expect(summary).toContain("doing×1");
		expect(summary).toContain("open gates: 1");
		expect(summary).toContain("r1/t2→merged");
	});
});
