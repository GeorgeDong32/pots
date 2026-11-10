/**
 * M4 patrol — durable sleeping task per bound workspace (P1-2.3).
 *
 * Crash-safety order (F11): the LastSeen hash is committed BEFORE the post;
 * posted diff ids are recorded after the post, so a rerun after a crash between
 * the two finds the diff already in `postedDiffIds` and skips re-posting
 * (B3: kill -9 after escalate → no duplicate push). Escalations carry
 * provenance labels and summaries only, never raw board content into an
 * instruction position (F27).
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineExtension, defineTask, type Extension, type TaskRuntime } from "@earendil-works/pi-durable";
import { BindingsDoc, PatrolDoc, type ChannelBinding } from "./docs.ts";

export interface PatrolDeps {
	/** Read the board file; null when missing. */
	readBoard(boardPath: string): Promise<string | null>;
	/** Post an escalation to the workspace channel. */
	post(chatId: string, text: string): Promise<void>;
	/** Human-readable summary of a board snapshot. */
	summarize(boardPath: string, content: string): string;
	/** Poll interval; overridable in tests. */
	intervalMs?: number;
}

export interface PatrolInput {
	chatId: string;
}

type PatrolCheckpoint =
	| { phase: "poll" }
	| { phase: "escalate"; diffId: string; summary: string };

const DEFAULT_PATROL_INTERVAL_MS = 60_000;
const POSTED_RING = 20;

export function createPatrolTask(deps: PatrolDeps) {
	return defineTask<PatrolInput, PatrolCheckpoint, null, object>({
		name: "pots.patrol",
		version: 1,
		initial: () => ({ phase: "poll" }),
		phases: {
			poll: async (task, runtime: TaskRuntime<PatrolInput, PatrolCheckpoint, null, object>, context: Context) => {
				const chatId = task.input.chatId;
				const interval = deps.intervalMs ?? DEFAULT_PATROL_INTERVAL_MS;
				// Crash re-entry: a pendingDiff left by an interrupted escalate phase
				// resumes there (postedDiffIds ring prevents a duplicate post).
				const prior = await runtime.snapshot(PatrolDoc, chatId, context);
				if (prior?.pendingDiff !== undefined) {
					const { diffId, summary } = prior.pendingDiff;
					await runtime.commit(
						() => ({ status: "running", checkpoint: { phase: "escalate", diffId, summary } }) as const,
						context,
					);
					return;
				}
				const table = await runtime.snapshot(BindingsDoc, context);
				const binding: ChannelBinding | undefined = table?.bindings[chatId];
				const boardPath = binding?.boardPath;
				if (!boardPath) {
					await runtime.sleepUntil(Date.now() + interval, { phase: "poll" }, context);
					return;
				}
				const content = await deps.readBoard(boardPath);
				if (content === null) {
					await runtime.sleepUntil(Date.now() + interval, { phase: "poll" }, context);
					return;
				}
				const hash = hashString(content);
				const state = await runtime.snapshot(PatrolDoc, chatId, context);
				const lastHash = state?.lastHash ?? "";
				if (lastHash === "") {
					// First sighting only records the baseline (no spam on startup).
					await runtime.commit(async (tx) => {
						const doc = await tx.doc(PatrolDoc, chatId, chatId);
						doc.lastHash = hash;
						return undefined;
					}, context);
					await runtime.sleepUntil(Date.now() + interval, { phase: "poll" }, context);
					return;
				}
				if (hash === lastHash) {
					await runtime.sleepUntil(Date.now() + interval, { phase: "poll" }, context);
					return;
				}
				// Change detected: commit LastSeen + pending diff FIRST (F11), then escalate.
				const summary = deps.summarize(boardPath, content);
				const diffId = `${hashString(boardPath)}:${hash}`;
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(PatrolDoc, chatId, chatId);
					doc.lastHash = hash;
					doc.pendingDiff = { diffId, summary };
					return undefined;
				}, context);
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "escalate", diffId, summary } }) as const,
					context,
				);
			},
			escalate: async (task, runtime: TaskRuntime<PatrolInput, PatrolCheckpoint, null, object>, context: Context) => {
				const interval = deps.intervalMs ?? DEFAULT_PATROL_INTERVAL_MS;
				const chatId = task.input.chatId;
				const checkpoint = task.state.checkpoint;
				if (checkpoint.phase !== "escalate") {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "poll" } }) as const, context);
					return;
				}
				const state = await runtime.snapshot(PatrolDoc, chatId, context);
				const posted = state?.postedDiffIds ?? [];
				if (!posted.includes(checkpoint.diffId)) {
					// F27: summary + provenance only; board content is untrusted external data.
					try {
						await deps.post(chatId, `📋 board 有变化（来自 ${checkpoint.diffId.slice(0, 8)} 的巡检摘要）\n${checkpoint.summary}`);
					} catch {
						// Post failure is not fatal; stays unposted and retries next round.
					}
				}
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(PatrolDoc, chatId, chatId);
					doc.postedDiffIds = [...doc.postedDiffIds, checkpoint.diffId].slice(-POSTED_RING);
					delete doc.pendingDiff;
					return undefined;
				}, context);
				await runtime.sleepUntil(Date.now() + interval, { phase: "poll" }, context);
			},
		},
		abort: (_task, runtime) =>
			runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }) as const,
				BACKGROUND_CONTEXT,
			),
	});
}

/** FNV-1a content hash (change detection only, not cryptographic). */
export function hashString(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16);
}

/** Registry wrapper so app code never imports pi-durable (import gate). */
export function createPatrolExtension(task: ReturnType<typeof createPatrolTask>): Extension {
	return defineExtension({ name: "pots-patrol-ext", tasks: [task] });
}
