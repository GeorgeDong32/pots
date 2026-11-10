import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeRoutine, tickRoutines } from "../src/routine-run.ts";
import { saveRoutines, withNextRun, type RoutineRecord } from "../src/routine-store.ts";

function routine(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
	return withNextRun({
		id: "job",
		name: "job",
		enabled: true,
		shadow: true,
		schedule: { kind: "interval", minutes: 60 },
		deliver: "feishu:oc_target",
		origin: { platform: "feishu", chatId: "oc_home" },
		noAgent: true,
		script: "report.sh",
		prompt: "",
		workdir: "/tmp",
		continuity: false,
		nextRunAt: null,
		lastRunAt: null,
		lastStatus: null,
		lastOutput: "",
		running: false,
		...overrides,
	}, 0);
}

describe("routine execution", () => {
	it("writes shadow output and does not post, even when deliver names a chat", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pots-shadow-"));
		const posts: string[] = [];
		const result = await executeRoutine(routine(), {
			exec: async () => ({ stdout: "report body", code: 0 }),
			complete: async () => "should not run",
			post: async (chatId) => {
				posts.push(chatId);
			},
			shadowDir: dir,
			homes: { feishu: "oc_home" },
			now: 1_000,
		});
		expect(result.delivered).toBe(false);
		expect(posts).toEqual([]);
		expect(readFileSync(join(dir, "job.txt"), "utf8")).toBe("report body");
	});

	it("advances the next slot when the script fails, so a tick does not retry immediately", async () => {
		const item = routine();
		item.nextRunAt = 500;
		const result = await executeRoutine(item, {
			exec: async () => ({ stdout: "nope", code: 1 }),
			complete: async () => "",
			post: async () => undefined,
			shadowDir: tmpdir(),
			homes: {},
			now: 1_000,
		});
		expect(result.status).toBe("error");
		expect(item.nextRunAt).toBeGreaterThan(1_000);
	});

	it("posts only after the routine is armed", async () => {
		const posts: string[] = [];
		const keys: string[] = [];
		const result = await executeRoutine(routine({ shadow: false, script: null, noAgent: false, prompt: "summarize" }), {
			exec: async () => ({ stdout: "", code: 0 }),
			complete: async () => "hello channel",
			post: async (chatId, _threadId, _text, idempotencyKey) => {
				posts.push(chatId);
				if (idempotencyKey !== undefined) keys.push(idempotencyKey);
			},
			shadowDir: tmpdir(),
			homes: {},
			now: 2_000,
		});
		expect(result.delivered).toBe(true);
		expect(posts).toEqual(["oc_target"]);
		expect(keys).toEqual([expect.stringMatching(/^routine:job:\d+:oc_target$/)]);
	});

	it("runs a due shadowed routine from the store without posting", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pots-store-"));
		const file = join(dir, "routines.json");
		const item = { ...routine(), nextRunAt: 500 };
		saveRoutines(file, [item]);
		writeFileSync(join(dir, "keep"), "");
		const posts: string[] = [];
		const results = await tickRoutines(file, {
			exec: async () => ({ stdout: "tick", code: 0 }),
			complete: async () => "",
			post: async (chatId) => {
				posts.push(chatId);
			},
			shadowDir: join(dir, "shadow"),
			homes: {},
			now: 1_000,
		});
		expect(results.map((result) => result.status)).toEqual(["ok"]);
		expect(posts).toEqual([]);
		expect(readFileSync(join(dir, "shadow", "job.txt"), "utf8")).toBe("tick");
	});
});
