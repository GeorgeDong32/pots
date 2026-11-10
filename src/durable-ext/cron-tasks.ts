/**
 * P3-3 cron family — durable sleeping tasks.
 *
 * MorningReport (P3-3.1): daily 09:00 wall-clock. Mac-sleep missed runs are
 * caught up on wake (D3'): a sleeping task past its deadline runs as soon as
 * the scheduler wakes — we deliver when the deadline is the most recent one
 * and we are within the same day; a deadline from a previous day is skipped
 * as stale (missed-run ≤ same-day catch-up, no double sends).
 *
 * Reminder (P3-3.2): the README Reminder pattern verbatim — one task per
 * reminder, sleepUntil(at) → deliver via the channel.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, defineTask, type Extension, type TaskRuntime } from "@earendil-works/pi-durable";
import { num, obj, str } from "@earendil-works/pi-schema";

/** Next 09:00 local time strictly after `now`; also returns the deadline's day. */
export function nextMorningReport(now = Date.now()): { at: number; day: string } {
	const d = new Date(now);
	d.setHours(9, 0, 0, 0);
	if (d.getTime() <= now) d.setDate(d.getDate() + 1);
	return { at: d.getTime(), day: d.toISOString().slice(0, 10) };
}

/** True when a wake at `wokeAt` for deadline `dueAt` is a same-day catch-up. */
export function isMissedRunSameDay(dueAt: number, wokeAt: number): boolean {
	if (wokeAt <= dueAt) return true; // on time
	const due = new Date(dueAt);
	const woke = new Date(wokeAt);
	return due.toDateString() === woke.toDateString();
}

export interface CronDeps {
	/** Compose the report body (boards + calendar via lark-cli). */
	morningBody(): Promise<string>;
	/** Deliver a line to the home chat. */
	post(text: string): Promise<void>;
}

export interface MorningInput {
	/** The last day we delivered (idempotency: one report per day). */
	lastDay?: string;
}

type MorningCheckpoint = { phase: "wait"; dueAt: number; day: string } | { phase: "deliver"; dueAt: number; day: string };

export function createMorningReportTask(deps: CronDeps) {
	return defineTask<Record<string, never>, MorningCheckpoint, null, object>({
		name: "pots.morning-report",
		version: 1,
		initial: () => {
			const { at, day } = nextMorningReport();
			return { phase: "wait", dueAt: at, day };
		},
		phases: {
			wait: async (_task, runtime: TaskRuntime<Record<string, never>, MorningCheckpoint, null, object>, context: Context) => {
				const checkpoint = _task.state.checkpoint;
				await runtime.sleepUntil(checkpoint.dueAt, { phase: "deliver", dueAt: checkpoint.dueAt, day: checkpoint.day }, context);
			},
			deliver: async (_task, runtime: TaskRuntime<Record<string, never>, MorningCheckpoint, null, object>, context: Context) => {
				const { dueAt, day } = _task.state.checkpoint;
				// D3': a wake past the deadline still delivers on the same day;
				// a stale (previous-day) deadline is skipped, never double-sent.
				if (isMissedRunSameDay(dueAt, Date.now())) {
					try {
						await deps.post(`☀️ 晨报 ${day}\n${await deps.morningBody()}`);
					} catch {
						// delivery failure: retry next day (documented trade-off)
					}
				}
				const next = nextMorningReport();
				await runtime.commit(
					() => ({ status: "sleeping", until: next.at, checkpoint: { phase: "wait", dueAt: next.at, day: next.day } }) as const,
					context,
				);
			},
		},
		abort: (_task, runtime) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }) as const, BACKGROUND_CONTEXT),
	});
}

export interface ReminderInput {
	text: string;
	at: number;
}

export function createReminderTask(post: (text: string) => Promise<void>) {
	return defineTask<ReminderInput, { phase: "wait" } | { phase: "deliver" }, null, object>({
		name: "pots.reminder",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				await runtime.sleepUntil(task.input.at, { phase: "deliver" }, context);
			},
			deliver: async (task, runtime, context) => {
				try {
					await post(`⏰ 提醒：${task.input.text}`);
				} finally {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }) as const,
						context,
					);
				}
			},
		},
		abort: (_task, runtime) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }) as const, BACKGROUND_CONTEXT),
	});
}

/** The `remind` tool: NOT whitelisted — creating durable side effects goes through M5. */
export function createReminderExtension(reminderTask: ReturnType<typeof createReminderTask>): Extension {
	const remind = defineTool({
		name: "remind",
		description:
			"Schedule a reminder (epoch ms `at`, message `text`). Delivered to the home chat by a durable task that survives restarts.",
		parameters: obj({ at: num(), text: str() }),
		execute: async (args, api, context) => {
			await api.commit(async (tx) => {
				await tx.createTask(reminderTask, { text: args.text, at: args.at }, { ownership: { kind: "conversation" } });
			}, context);
			return { output: [{ type: "text", text: `reminder set for ${new Date(args.at).toLocaleString("zh-CN")}` }] };
		},
	});
	return defineExtension({ name: "pots-remind", tools: [remind], tasks: [reminderTask] });
}

/** Registry wrapper for the daemon-created morning task (import gate). */
export function createCronExtension(morningTask: ReturnType<typeof createMorningReportTask>): Extension {
	return defineExtension({ name: "pots-cron", tasks: [morningTask] });
}
