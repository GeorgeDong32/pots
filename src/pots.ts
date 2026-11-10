#!/usr/bin/env node
/**
 * pots — routine and service commands.
 * Import and run stay in shadow unless a routine is explicitly armed.
 * arm --confirm pauses only the same-named Hermes job, then sends over HTTP.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { executeRoutine } from "./routine-run.ts";
import { importHermesJob } from "./routine.ts";
import { loadRoutines, newRoutineId, saveRoutines, withNextRun, type RoutineRecord } from "./routine-store.ts";
import { parseSchedule } from "./schedule.ts";
import { resolveDeliver } from "./deliver.ts";
import { pauseHermesJobByName } from "./hermes-jobs.ts";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function storePath(): string {
	return flag("--store") ?? join(process.env.POTS_HOME ?? join(homedir(), ".pots"), "routines.json");
}

function shadowDir(): string {
	return join(storePath(), "..", "routine-shadow");
}

const command = args[0];
const sub = args[1];

if (command === "routine" && sub === "import") {
	const file = flag("--file");
	if (file === undefined) {
		console.error("pots: --file is required");
		process.exit(2);
	}
	const parsed = JSON.parse(readFileSync(file, "utf8")) as { jobs?: unknown[] };
	const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
	const drafts = jobs.filter((job): job is Record<string, unknown> => job !== null && typeof job === "object").map((job) => importHermesJob(job));
	for (const draft of drafts) {
		console.log([draft.enabled ? "enabled" : "paused", draft.name, `deliver=${draft.deliver}`, "shadow"].join("\t"));
	}
	console.log(`${drafts.length} routines (dry-run; delivery stays shadowed)`);
	if (!args.includes("--write")) process.exit(0);
	if (!args.includes("--confirm")) {
		console.error("pots: --write needs a separate --confirm");
		process.exit(2);
	}
	const now = Date.now();
	const routines: RoutineRecord[] = drafts.map((draft) => withNextRun({
		id: draft.id ?? newRoutineId(),
		name: draft.name,
		enabled: draft.enabled,
		shadow: true,
		schedule: draft.schedule,
		deliver: draft.deliver,
		origin: draft.origin,
		noAgent: draft.noAgent,
		script: draft.script,
		prompt: draft.prompt,
		workdir: draft.workdir,
		continuity: draft.continuity,
		nextRunAt: null,
		lastRunAt: null,
		lastStatus: null,
		lastOutput: "",
		running: false,
	}, now));
	saveRoutines(flag("--out") ?? storePath(), routines);
	console.log(`wrote ${routines.length} shadowed routines`);
	process.exit(0);
}

if (command === "routine" && sub === "list") {
	for (const routine of loadRoutines(storePath())) {
		console.log([routine.enabled ? "enabled" : "paused", routine.shadow ? "shadow" : "armed", routine.id, routine.name, routine.deliver].join("\t"));
	}
	process.exit(0);
}

if (command === "routine" && sub === "doctor") {
	let problems = 0;
	for (const routine of loadRoutines(storePath())) {
		if (routine.running) {
			console.log(`stuck running flag ${routine.name}`);
			problems += 1;
		}
		if (routine.enabled && routine.nextRunAt !== null && routine.nextRunAt < Date.now() - 15 * 60 * 1000) {
			console.log(`overdue ${routine.name}`);
			problems += 1;
		}
		if (routine.script && routine.workdir && !existsSync(join(routine.workdir, routine.script)) && !existsSync(routine.script)) {
			console.log(`missing script ${routine.name}: ${routine.script}`);
			problems += 1;
		}
		const resolved = resolveDeliver(routine.shadow ? "local" : routine.deliver, { origin: routine.origin ?? undefined, homes: {} });
		if (resolved.kind === "error") {
			console.log(`deliver ${routine.name}: ${resolved.message}`);
			problems += 1;
		}
	}
	console.log(problems === 0 ? "doctor: ok" : `doctor: ${problems} problem(s)`);
	process.exit(problems === 0 ? 0 : 2);
}

if (command === "routine" && sub === "create") {
	const name = flag("--name");
	const scheduleRaw = flag("--schedule");
	if (!name || !scheduleRaw) {
		console.error("pots: create needs --name and --schedule");
		process.exit(2);
	}
	const now = Date.now();
	const routine = withNextRun({
		id: newRoutineId(),
		name,
		enabled: true,
		shadow: true,
		schedule: parseSchedule(scheduleRaw, now),
		deliver: flag("--deliver") ?? "local",
		origin: null,
		noAgent: args.includes("--no-agent"),
		script: flag("--script") ?? null,
		prompt: flag("--prompt") ?? "",
		workdir: flag("--workdir") ?? null,
		continuity: false,
		nextRunAt: null,
		lastRunAt: null,
		lastStatus: null,
		lastOutput: "",
		running: false,
	}, now);
	const routines = loadRoutines(storePath());
	routines.push(routine);
	saveRoutines(storePath(), routines);
	console.log(`created ${routine.id} ${routine.name} (shadow)`);
	process.exit(0);
}

if (command === "routine" && sub === "edit") {
	const id = args[2];
	const routines = loadRoutines(storePath());
	const routine = routines.find((item) => item.id === id || item.name === id);
	if (routine === undefined) {
		console.error(`pots: no routine ${id}`);
		process.exit(2);
	}
	const scheduleRaw = flag("--schedule");
	if (scheduleRaw) routine.schedule = parseSchedule(scheduleRaw);
	const prompt = flag("--prompt");
	if (prompt !== undefined) routine.prompt = prompt;
	const deliver = flag("--deliver");
	if (deliver !== undefined) routine.deliver = deliver;
	const script = flag("--script");
	if (script !== undefined) routine.script = script;
	routine.nextRunAt = routine.enabled ? withNextRun(routine, Date.now()).nextRunAt : null;
	saveRoutines(storePath(), routines);
	console.log(`edited ${routine.name}`);
	process.exit(0);
}

if (command === "routine" && (sub === "pause" || sub === "resume" || sub === "arm")) {
	const id = args[2];
	const routines = loadRoutines(storePath());
	const routine = routines.find((item) => item.id === id || item.name === id);
	if (routine === undefined) {
		console.error(`pots: no routine ${id}`);
		process.exit(2);
	}
	if (sub === "pause") routine.enabled = false;
	if (sub === "resume") routine.enabled = true;
	if (sub === "arm") {
		if (!args.includes("--confirm")) {
			console.error("pots: arm sends to the routine's deliver target. Pass --confirm.");
			process.exit(2);
		}
		const jobsFile = flag("--hermes-jobs") ?? join(process.env.HERMES_HOME ?? join(homedir(), ".hermes"), "cron", "jobs.json");
		try {
			const paused = pauseHermesJobByName(jobsFile, routine.name);
			console.log(paused.alreadyPaused
				? `Hermes job ${paused.id} (${paused.name}) was already paused`
				: `paused Hermes job ${paused.id} (${paused.name})`);
		} catch (error) {
			console.error((error as Error).message);
			process.exit(2);
		}
		routine.shadow = false;
	}
	routine.nextRunAt = routine.enabled ? withNextRun(routine, Date.now()).nextRunAt : null;
	saveRoutines(storePath(), routines);
	console.log(`${sub} ${routine.name}`);
	process.exit(0);
}

if (command === "routine" && sub === "run") {
	const id = args[2];
	const routines = loadRoutines(storePath());
	const routine = routines.find((item) => item.id === id || item.name === id);
	if (routine === undefined) {
		console.error(`pots: no routine ${id}`);
		process.exit(2);
	}
	const forcedShadow = !args.includes("--confirm");
	const previousShadow = routine.shadow;
	if (forcedShadow) routine.shadow = true;
	const result = await executeRoutine(routine, {
		exec: (file, execArgs, cwd) => {
			try {
				const stdout = execFileSync(file, execArgs, { cwd, encoding: "utf8", timeout: 120_000 });
				return Promise.resolve({ stdout, code: 0 });
			} catch (error) {
				const failed = error as { stdout?: string; status?: number };
				return Promise.resolve({ stdout: failed.stdout ?? "", code: failed.status ?? 1 });
			}
		},
		complete: async () => {
			throw new Error("agent routines run inside the daemon (POTS_SKIP_CHANNEL=1 keeps Feishu disconnected)");
		},
		post: async () => {
			throw new Error("CLI run does not post. Start the daemon after arming.");
		},
		shadowDir: shadowDir(),
		homes: {},
	});
	if (forcedShadow) routine.shadow = previousShadow;
	saveRoutines(storePath(), routines);
	console.log(`${result.status} delivered=${result.delivered} ${result.detail ?? ""}`.trim());
	if (result.output) console.log(result.output.slice(0, 2000));
	process.exit(result.status === "ok" ? 0 : 1);
}

if (command === "status") {
	const statusFile = flag("--status") ?? join(homedir(), ".pots", "status.json");
	if (!existsSync(statusFile)) {
		console.log("pots: daemon status file is absent");
		process.exit(0);
	}
	const status = JSON.parse(readFileSync(statusFile, "utf8")) as { pid?: number; uptimeMs?: number; lastError?: string };
	console.log(`pid ${status.pid ?? "-"} uptime ${Math.round((status.uptimeMs ?? 0) / 1000)}s lastError ${status.lastError ?? "none"}`);
	process.exit(0);
}

console.log("usage: pots status | pots routine import|list|doctor|create|edit|pause|resume|arm|run");
process.exit(command === undefined ? 0 : 2);
