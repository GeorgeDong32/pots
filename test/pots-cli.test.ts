import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("pots CLI", () => {
	it("creates a shadowed script routine and runs it without posting", () => {
		const dir = mkdtempSync(join(tmpdir(), "pots-cli-"));
		const store = join(dir, "routines.json");
		const script = join(dir, "echo.sh");
		writeFileSync(script, "#!/bin/sh\necho hello-pots\n");
		chmodSync(script, 0o755);
		execFileSync("./scripts/pots", [
			"routine", "create",
			"--store", store,
			"--name", "hi",
			"--schedule", "every 1h",
			"--script", script,
			"--no-agent",
			"--workdir", dir,
			"--deliver", "feishu:oc_should_not_send",
		], { encoding: "utf8" });
		const output = execFileSync("./scripts/pots", ["routine", "run", "hi", "--store", store], { encoding: "utf8" });
		expect(output).toContain("delivered=false");
		const shadow = join(dir, "routine-shadow");
		const files = readdirSync(shadow);
		expect(files).toHaveLength(1);
		expect(readFileSync(join(shadow, files[0] ?? ""), "utf8")).toContain("hello-pots");
	});

	it("arms only after pausing the same-named Hermes job", () => {
		const dir = mkdtempSync(join(tmpdir(), "pots-arm-"));
		const store = join(dir, "routines.json");
		const jobs = join(dir, "jobs.json");
		writeFileSync(jobs, JSON.stringify({
			jobs: [
				{ id: "job-hi", name: "hi", enabled: true, state: "scheduled" },
				{ id: "job-other", name: "other", enabled: true, state: "scheduled" },
			],
		}));
		execFileSync("./scripts/pots", [
			"routine", "create",
			"--store", store,
			"--name", "hi",
			"--schedule", "every 1h",
			"--no-agent",
			"--deliver", "local",
		], { encoding: "utf8" });
		const output = execFileSync("./scripts/pots", [
			"routine", "arm", "hi", "--confirm",
			"--store", store,
			"--hermes-jobs", jobs,
		], { encoding: "utf8" });
		expect(output).toContain("paused Hermes job job-hi (hi)");
		const saved = JSON.parse(readFileSync(jobs, "utf8")) as { jobs: Array<{ id: string; enabled: boolean }> };
		expect(saved.jobs.find((job) => job.id === "job-hi")?.enabled).toBe(false);
		expect(saved.jobs.find((job) => job.id === "job-other")?.enabled).toBe(true);
		const routines = JSON.parse(readFileSync(store, "utf8")) as { routines: Array<{ name: string; shadow: boolean }> };
		expect(routines.routines.find((item) => item.name === "hi")?.shadow).toBe(false);
	});

	it("refuses to arm when Hermes has no job of that name", () => {
		const dir = mkdtempSync(join(tmpdir(), "pots-arm-"));
		const store = join(dir, "routines.json");
		const jobs = join(dir, "jobs.json");
		writeFileSync(jobs, JSON.stringify({ jobs: [{ id: "job-other", name: "other", enabled: true }] }));
		execFileSync("./scripts/pots", [
			"routine", "create",
			"--store", store,
			"--name", "hi",
			"--schedule", "every 1h",
			"--no-agent",
			"--deliver", "local",
		], { encoding: "utf8" });
		expect(() => execFileSync("./scripts/pots", [
			"routine", "arm", "hi", "--confirm",
			"--store", store,
			"--hermes-jobs", jobs,
		], { encoding: "utf8" })).toThrow(/no Hermes job named hi/);
		const routines = JSON.parse(readFileSync(store, "utf8")) as { routines: Array<{ shadow: boolean }> };
		expect(routines.routines[0]?.shadow).toBe(true);
	});
});
