/**
 * Pause one Hermes cron job by exact name before pots arms the same routine.
 * Other jobs, and the gateway process, are left alone.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface HermesJob {
	id?: string;
	name?: string;
	enabled?: boolean;
	state?: string;
	paused_at?: string | null;
	paused_reason?: string | null;
	[key: string]: unknown;
}

export interface PausedHermesJob {
	id: string;
	name: string;
	alreadyPaused: boolean;
}

export function pauseHermesJobByName(file: string, name: string, now = new Date().toISOString()): PausedHermesJob {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`pots: no Hermes job named ${name}; refusing to arm`);
		}
		throw error;
	}
	const parsed = JSON.parse(raw) as { jobs?: HermesJob[] } | HermesJob[];
	const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
	if (!Array.isArray(jobs)) throw new Error(`pots: Hermes jobs file has no jobs array: ${file}`);
	const matches = jobs.filter((job) => job.name === name);
	if (matches.length === 0) throw new Error(`pots: no Hermes job named ${name}; refusing to arm`);
	if (matches.length > 1) {
		const ids = matches.map((job) => String(job.id ?? "?")).join(", ");
		throw new Error(`pots: multiple Hermes jobs named ${name} (${ids}); refusing to arm`);
	}
	const job = matches[0];
	if (job === undefined) throw new Error(`pots: no Hermes job named ${name}; refusing to arm`);
	const id = String(job.id ?? name);
	if (job.enabled === false) return { id, name, alreadyPaused: true };
	job.enabled = false;
	job.state = "paused";
	job.paused_at = now;
	job.paused_reason = "paused by pots arm";
	const next = `${JSON.stringify(parsed, null, 2)}\n`;
	const tmp = join(dirname(file), `.${file.split("/").pop()}.pots-tmp`);
	writeFileSync(tmp, next);
	renameSync(tmp, file);
	return { id, name, alreadyPaused: false };
}
