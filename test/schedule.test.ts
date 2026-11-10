import { describe, expect, it } from "vitest";
import { nextRun, parseSchedule } from "../src/schedule.ts";

const TZ = "Asia/Shanghai";

describe("schedule", () => {
	it("parses cron, interval, and one-shot forms", () => {
		expect(parseSchedule("15 9 * * *").kind).toBe("cron");
		expect(parseSchedule("every 2h")).toEqual({ kind: "interval", minutes: 120 });
		expect(parseSchedule("30m")).toEqual({ kind: "interval", minutes: 30 });
		const once = parseSchedule("in 15m", Date.parse("2026-11-09T01:00:00Z"));
		expect(once).toEqual({ kind: "once", runAt: Date.parse("2026-11-09T01:15:00Z") });
	});

	it("fires a daily clock in Asia/Shanghai and skips to the next day after the slot", () => {
		const schedule = parseSchedule("15 9 * * *");
		expect(nextRun(schedule, Date.parse("2026-11-09T01:00:00Z"), TZ)).toBe(Date.parse("2026-11-09T01:15:00Z"));
		expect(nextRun(schedule, Date.parse("2026-11-09T02:00:00Z"), TZ)).toBe(Date.parse("2026-11-10T01:15:00Z"));
	});

	it("keeps weekday jobs off the weekend", () => {
		const schedule = parseSchedule("0 22 * * 1-5");
		expect(nextRun(schedule, Date.parse("2026-11-09T04:00:00Z"), TZ)).toBe(Date.parse("2026-11-09T14:00:00Z"));
		expect(nextRun(schedule, Date.parse("2026-11-14T15:00:00Z"), TZ)).toBe(Date.parse("2026-11-16T14:00:00Z"));
	});
});
