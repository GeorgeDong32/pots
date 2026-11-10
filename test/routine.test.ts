import { describe, expect, it } from "vitest";
import { executionMode, importHermesJob } from "../src/routine.ts";

describe("routine import", () => {
	it("keeps paused jobs paused and does not let origin replace deliver", () => {
		const active = importHermesJob({
			name: "daily",
			enabled: true,
			schedule: { kind: "cron", expr: "0 22 * * 1-5" },
			deliver: "feishu:oc_finance",
			origin: { platform: "feishu", chat_id: "oc_home" },
			prompt: "summarize",
			no_agent: false,
		});
		expect(active.enabled).toBe(true);
		expect(active.deliver).toBe("feishu:oc_finance");
		expect(active.origin).toEqual({ platform: "feishu", chatId: "oc_home" });
		expect(executionMode(active)).toBe("agent");

		const paused = importHermesJob({
			name: "nav",
			enabled: false,
			state: "paused",
			schedule: { expr: "5 22 * * 1-5" },
			deliver: "feishu:oc_finance",
			no_agent: true,
			script: "nav.sh",
		});
		expect(paused.enabled).toBe(false);
		expect(executionMode(paused)).toBe("script");
	});

	it("treats a script plus a prompt as an agent that sees the script output", () => {
		const draft = importHermesJob({
			name: "scan",
			schedule: "44 12,22 * * *",
			deliver: "feishu:oc_pr",
			script: "issue_scan.py",
			prompt: "interpret",
		});
		expect(executionMode(draft)).toBe("agent-script");
		expect(draft.origin).toBeNull();
	});
});
