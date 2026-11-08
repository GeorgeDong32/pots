/**
 * Minimal structured logger: one JSON line per event with the identifiers that
 * matter (chatId/messageId/requestId flow through `fields`). P3-4.2 extends the
 * vocabulary; the newline-JSON format is kept so log files stay greppable.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(minLevel: LogLevel = "info", sink: (line: string) => void = console.log): Logger {
	const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
	return {
		debug: (m, f) => order.debug >= order[minLevel] && sink(fmt("debug", m, f)),
		info: (m, f) => order.info >= order[minLevel] && sink(fmt("info", m, f)),
		warn: (m, f) => order.warn >= order[minLevel] && sink(fmt("warn", m, f)),
		error: (m, f) => order.error >= order[minLevel] && sink(fmt("error", m, f)),
	};
}

function fmt(level: LogLevel, message: string, fields?: Record<string, unknown>): string {
	// Redact anything whose key smells like a secret, defensively.
	const safe: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fields ?? {})) {
		safe[k] = /secret|token|key|password/i.test(k) ? "[redacted]" : v;
	}
	return JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...safe });
}
