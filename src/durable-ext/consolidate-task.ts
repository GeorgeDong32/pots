/**
 * P2-2.3: consolidation debounce (V2-C). After a run answers, wait 5min;
 * if a memory layer is over budget, admit a directive INPUT into the same
 * conversation (buildConsolidationDirective text) so the agent itself reads
 * the files and calls memory_consolidate. Bounded: the directive's run arms
 * the next debounce only, and a healthy layer arms nothing.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { MemoryV1Deps } from "./memory-ext.ts";

const DEBOUNCE_MS = 5 * 60 * 1000;

export interface ConsolidateInput {
	conversationId: number;
}

export type ConsolidateCheckpoint = { phase: "wait" } | { phase: "check" };

export function createConsolidateDebounceTask(v1: MemoryV1Deps, debounceMs = DEBOUNCE_MS) {
	return defineTask<ConsolidateInput, ConsolidateCheckpoint, null, object>({
		name: "pots.memory-consolidate-debounce",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime: TaskRuntime<ConsolidateInput, ConsolidateCheckpoint, null, object>, context: Context) => {
				await runtime.sleepUntil(Date.now() + debounceMs, { phase: "check" }, context);
			},
			check: async (task, runtime: TaskRuntime<ConsolidateInput, ConsolidateCheckpoint, null, object>, context: Context) => {
				const conv = await runtime.conversation(task.input.conversationId as never, context);
				if (conv === undefined) {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }) as const,
						context,
					);
					return;
				}
				const agent = await runtime.agent(context);
				const over = v1.overBudget(agent.cwd);
				for (const layer of over) {
					// The directive is an ordinary user input: provenance-labelled,
					// the agent decides and reports through memory_consolidate.
					await conv.submit(
						{
							type: "input",
							content:
								`[memory] ${layer.layer} 层超预算（${layer.reason}）。请阅读该层文件并调用 memory_consolidate ` +
								`完成一次收缩整合（batch 必须减小总量；删除需 provenance）。`,
							whenBusy: "followUp",
						},
						context,
					);
				}
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: null } }) as const,
					context,
				);
			},
		},
		abort: (_task, runtime) =>
			runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }) as const,
				BACKGROUND_CONTEXT,
			),
	});
}
