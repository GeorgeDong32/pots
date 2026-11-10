import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nextRun, type Schedule } from "./schedule.ts";

/** A stored routine. `shadow` keeps delivery on disk so Hermes is not duplicated. */
export interface RoutineRecord {
	id: string;
	name: string;
	enabled: boolean;
	shadow: boolean;
	schedule: Schedule;
	deliver: string;
	origin: { platform: string; chatId: string } | null;
	noAgent: boolean;
	script: string | null;
	prompt: string;
	workdir: string | null;
	continuity: boolean;
	nextRunAt: number | null;
	lastRunAt: number | null;
	lastStatus: string | null;
	lastOutput: string;
	running: boolean;
}

export function loadRoutines(file: string): RoutineRecord[] {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { routines?: RoutineRecord[] };
		return Array.isArray(parsed.routines) ? parsed.routines : [];
	} catch {
		return [];
	}
}

export function saveRoutines(file: string, routines: RoutineRecord[]): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ routines }, null, 2));
	renameSync(tmp, file);
}

export function newRoutineId(): string {
	return Math.random().toString(16).slice(2, 14);
}

export function releaseStuckRuns(file: string): void {
	const routines = loadRoutines(file);
	let changed = false;
	for (const routine of routines) {
		if (!routine.running) continue;
		routine.running = false;
		changed = true;
	}
	if (changed) saveRoutines(file, routines);
}

export function withNextRun(routine: RoutineRecord, now: number): RoutineRecord {
	return { ...routine, nextRunAt: routine.enabled ? nextRun(routine.schedule, now) : null };
}
