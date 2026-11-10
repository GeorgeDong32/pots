import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pauseHermesJobByName } from "../src/hermes-jobs.ts";

function jobsFile(jobs: unknown[]): string {
	const dir = mkdtempSync(join(tmpdir(), "pots-jobs-"));
	const file = join(dir, "jobs.json");
	writeFileSync(file, JSON.stringify({ jobs }, null, 2));
	return file;
}

describe("pause one Hermes job", () => {
	it("disables only the job with the same name", () => {
		const file = jobsFile([
			{ id: "a", name: "alpha", enabled: true, state: "scheduled", deliver: "feishu:oc_keep" },
			{ id: "b", name: "beta", enabled: true, state: "scheduled" },
		]);
		const paused = pauseHermesJobByName(file, "alpha", "2026-11-10T00:00:00.000Z");
		expect(paused).toEqual({ id: "a", name: "alpha", alreadyPaused: false });
		const saved = JSON.parse(readFileSync(file, "utf8")) as { jobs: Array<Record<string, unknown>> };
		expect(saved.jobs[0]).toMatchObject({
			id: "a",
			enabled: false,
			state: "paused",
			paused_at: "2026-11-10T00:00:00.000Z",
			paused_reason: "paused by pots arm",
			deliver: "feishu:oc_keep",
		});
		expect(saved.jobs[1]).toMatchObject({ id: "b", enabled: true, state: "scheduled" });
	});

	it("refuses when there is no same-named job", () => {
		const file = jobsFile([{ id: "b", name: "beta", enabled: true }]);
		expect(() => pauseHermesJobByName(file, "alpha")).toThrow(/no Hermes job named alpha/);
		const saved = JSON.parse(readFileSync(file, "utf8")) as { jobs: Array<{ enabled: boolean }> };
		expect(saved.jobs[0]?.enabled).toBe(true);
	});

	it("refuses when two jobs share the name", () => {
		const file = jobsFile([
			{ id: "a", name: "alpha", enabled: true },
			{ id: "c", name: "alpha", enabled: true },
		]);
		expect(() => pauseHermesJobByName(file, "alpha")).toThrow(/multiple Hermes jobs/);
		const saved = JSON.parse(readFileSync(file, "utf8")) as { jobs: Array<{ enabled: boolean }> };
		expect(saved.jobs.every((job) => job.enabled)).toBe(true);
	});
});
