import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDeliver } from "./deliver.ts";
import { nextRun } from "./schedule.ts";
import { loadRoutines, saveRoutines, type RoutineRecord } from "./routine-store.ts";

export interface RoutineEffects {
	exec(file: string, args: string[], cwd: string): Promise<{ stdout: string; code: number }>;
	complete(routineId: string, prompt: string, place?: { cwd: string; chatId: string; slot: string }): Promise<string>;
	post(chatId: string, threadId: string | undefined, text: string, idempotencyKey?: string): Promise<void>;
	shadowDir: string;
	homes: Record<string, string>;
	now?: number;
}

export interface RoutineResult {
	id: string;
	status: "ok" | "error" | "skipped";
	output: string;
	delivered: boolean;
	detail?: string;
}

/** Run one routine. Shadow and `deliver=local` never call `post`. */
export async function executeRoutine(routine: RoutineRecord, effects: RoutineEffects): Promise<RoutineResult> {
	const now = effects.now ?? Date.now();
	try {
		let scriptOutput = "";
		if (routine.script) {
			const ran = await runScript(routine, effects);
			if (ran.code !== 0) {
				routine.lastRunAt = now;
				routine.lastStatus = "error";
				routine.nextRunAt = nextRun(routine.schedule, now);
				return { id: routine.id, status: "error", output: ran.stdout, delivered: false, detail: `script exit ${ran.code}` };
			}
			scriptOutput = ran.stdout;
		}
		let output = scriptOutput;
		if (!routine.noAgent) {
			const prior = routine.continuity && routine.lastOutput ? `上一档输出：\n${routine.lastOutput}\n\n` : "";
			const scriptNote = scriptOutput ? `脚本输出：\n${scriptOutput}\n\n` : "";
			output = await effects.complete(routine.id, `${prior}${scriptNote}${routine.prompt}`, {
				cwd: routine.workdir ?? process.cwd(),
				chatId: routine.origin?.chatId ?? "",
				slot: String(routine.nextRunAt ?? now),
			});
		}
		const delivered = await deliverOutput(routine, output, effects);
		routine.lastRunAt = now;
		routine.lastStatus = "ok";
		routine.lastOutput = output.slice(0, 8000);
		routine.nextRunAt = nextRun(routine.schedule, now);
		return { id: routine.id, status: "ok", output, delivered };
	} catch (error) {
		routine.lastRunAt = now;
		routine.lastStatus = "error";
		routine.nextRunAt = nextRun(routine.schedule, now);
		return { id: routine.id, status: "error", output: "", delivered: false, detail: (error as Error).message };
	}
}

export async function tickRoutines(file: string, effects: RoutineEffects): Promise<RoutineResult[]> {
	const now = effects.now ?? Date.now();
	const routines = loadRoutines(file);
	const due = routines.filter((routine) => routine.enabled && !routine.running && routine.nextRunAt !== null && routine.nextRunAt <= now);
	if (due.length === 0) return [];
	for (const routine of due) routine.running = true;
	saveRoutines(file, routines);
	const results: RoutineResult[] = [];
	for (const routine of due) {
		const result = await executeRoutine(routine, { ...effects, now });
		routine.running = false;
		results.push(result);
		saveRoutines(file, routines);
	}
	return results;
}

async function runScript(routine: RoutineRecord, effects: RoutineEffects): Promise<{ stdout: string; code: number }> {
	const script = routine.script ?? "";
	const cwd = routine.workdir ?? process.cwd();
	if (script.endsWith(".py")) return effects.exec("python3", [script], cwd);
	if (script.endsWith(".sh")) return effects.exec("/bin/bash", [script], cwd);
	return effects.exec(script, [], cwd);
}

async function deliverOutput(routine: RoutineRecord, output: string, effects: RoutineEffects): Promise<boolean> {
	const target = routine.shadow ? "local" : routine.deliver;
	const resolved = resolveDeliver(target, { origin: routine.origin ?? undefined, homes: effects.homes });
	if (resolved.kind === "local" || routine.shadow) {
		mkdirSync(effects.shadowDir, { recursive: true });
		writeFileSync(join(effects.shadowDir, `${routine.id}.txt`), output);
		return false;
	}
	const slot = String(routine.nextRunAt ?? "now");
	if (resolved.kind === "chat") {
		await effects.post(resolved.chatId, resolved.threadId, output, `routine:${routine.id}:${slot}:${resolved.chatId}`);
		return true;
	}
	if (resolved.kind === "all") {
		for (const item of resolved.targets) {
			await effects.post(item.chatId, undefined, output, `routine:${routine.id}:${slot}:${item.chatId}`);
		}
		return true;
	}
	throw new Error(resolved.message);
}
