/** Schedules in the same three shapes Hermes accepts: cron, interval, and once. */

export type Schedule =
	| { kind: "cron"; expr: string }
	| { kind: "interval"; minutes: number }
	| { kind: "once"; runAt: number };

const FIELD = /^(\*|\d+(?:-\d+)?)(?:\/\d+)?$/;

export function parseSchedule(input: string, now = Date.now()): Schedule {
	const text = input.trim();
	const lower = text.toLowerCase();
	if (lower.startsWith("every ")) return { kind: "interval", minutes: parseDuration(text.slice(6)) };
	if (lower.startsWith("in ")) {
		const minutes = parseDuration(text.slice(3));
		return { kind: "once", runAt: now + minutes * 60_000 };
	}
	if (/^\d+(?:\.\d+)?\s*[mh]$/i.test(text)) return { kind: "interval", minutes: parseDuration(text) };
	if (text.includes("T") || /^\d{4}-\d{2}-\d{2}/.test(text)) {
		const runAt = Date.parse(text);
		if (!Number.isFinite(runAt)) throw new Error(`invalid timestamp: ${text}`);
		return { kind: "once", runAt };
	}
	const fields = text.split(/\s+/);
	if (fields.length === 5 && fields.every((field) => field.split(",").every((part) => FIELD.test(part)))) {
		return { kind: "cron", expr: text };
	}
	throw new Error(`invalid schedule: ${text}`);
}

export function nextRun(schedule: Schedule, now: number, timeZone = "Asia/Shanghai"): number | null {
	if (schedule.kind === "once") return schedule.runAt > now ? schedule.runAt : null;
	if (schedule.kind === "interval") return now + schedule.minutes * 60_000;
	const limit = now + 366 * 24 * 60 * 60 * 1000;
	for (let at = Math.floor(now / 60_000) * 60_000 + 60_000; at <= limit; at += 60_000) {
		if (cronMatches(schedule.expr, at, timeZone)) return at;
	}
	return null;
}

function parseDuration(text: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*([mh])$/.exec(text.trim().toLowerCase());
	if (match === null) throw new Error(`invalid duration: ${text}`);
	const amount = Number(match[1]);
	return match[2] === "h" ? amount * 60 : amount;
}

function cronMatches(expr: string, at: number, timeZone: string): boolean {
	const [minute, hour, dom, month, dow] = expr.split(/\s+/);
	const parts = zonedParts(at, timeZone);
	if (parts === undefined) return false;
	if (!matchField(parts.minute, minute, 0, 59)) return false;
	if (!matchField(parts.hour, hour, 0, 23)) return false;
	if (!matchField(parts.month, month, 1, 12)) return false;
	const domOk = matchField(parts.day, dom, 1, 31);
	const dowOk = matchField(parts.dow, normalizeDow(dow), 0, 6);
	if (dom !== "*" && dow !== "*") return domOk || dowOk;
	return domOk && dowOk;
}

function normalizeDow(spec: string): string {
	return spec
		.split(",")
		.map((part) => {
			const [range, step] = part.split("/");
			const normalized = range.split("-").map((bound) => (bound === "7" ? "0" : bound)).join("-");
			return step === undefined ? normalized : `${normalized}/${step}`;
		})
		.join(",");
}

function matchField(value: number, spec: string, min: number, max: number): boolean {
	if (spec === "*") return true;
	return spec.split(",").some((part) => {
		const [range, stepRaw] = part.split("/");
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		if (!Number.isFinite(step) || step <= 0) return false;
		let start = min;
		let end = max;
		if (range !== "*") {
			if (range.includes("-")) {
				const [from, to] = range.split("-");
				start = Number(from);
				end = Number(to);
			} else {
				start = Number(range);
				end = start;
			}
		}
		if (value < start || value > end) return false;
		return (value - start) % step === 0;
	});
}

function zonedParts(at: number, timeZone: string): { minute: number; hour: number; day: number; month: number; dow: number } | undefined {
	const formatted = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		weekday: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).formatToParts(new Date(at));
	const value = (type: string) => formatted.find((part) => part.type === type)?.value;
	const weekday = value("weekday");
	const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday ?? "");
	if (dow < 0) return undefined;
	let hour = Number(value("hour"));
	if (hour === 24) hour = 0;
	return { minute: Number(value("minute")), hour, day: Number(value("day")), month: Number(value("month")), dow };
}
