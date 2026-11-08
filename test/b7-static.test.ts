import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B7 (read-only discipline) — statically assertable halves:
 *  1. M4 code never WRITES the board: no flow-board write subcommand may be
 *     executed, and no fs write API may target board.json.
 *  2. M5's whitelist is a frozen allow-list: no mutation path, and every
 *     allow return sits behind the whitelist/session checks (runtime matrix
 *     lives in approvals.test.ts; here we pin the structure).
 */
const SRC = join(import.meta.dirname, "..", "src");

function src(...parts: string[]): string {
	return readFileSync(join(SRC, ...parts), "utf8");
}

describe("B7: M4 has no write path to flow-board", () => {
	const m4Sources = [src("supervisor.ts"), src("durable-ext", "supervisor-tools.ts"), src("durable-ext", "patrol-task.ts")];

	it("never invokes a flow-board write subcommand (only reads/JSON parses)", () => {
		for (const code of m4Sources) {
			const meaningful = code
				.split("\n")
				.filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
			const joined = meaningful.join("\n");
			expect(joined, "no write subcommand may appear").not.toMatch(
				/flow-board[^"'`]*\b(init|deploy|run|task|prefs|gate)\b/,
			);
		}
	});

	it("never performs an fs write that mentions board.json", () => {
		for (const code of m4Sources) {
			for (const line of code.split("\n")) {
				if (/(writeFile|appendFile|rename|unlink|rm|truncate)/.test(line)) {
					expect(line, `write line must not target board.json: ${line.trim()}`).not.toMatch(/board\.json/);
				}
			}
		}
	});

	it("dispatch notes go to the dispatch tree, never the board file", () => {
		const code = src("supervisor.ts");
		expect(code).toMatch(/dispatch/);
		expect(code).toMatch(/join\(projectDir, "dispatch", runName\)/);
	});
});

describe("B7: M5 whitelist outside has zero pass-through path", () => {
	const gate = src("durable-ext", "approval-gate.ts");

	it("the whitelist is a const allow-list with no mutation", () => {
		expect(gate).toMatch(/const READ_ONLY_WHITELIST = new Set\(/);
		expect(gate).not.toMatch(/READ_ONLY_WHITELIST\.(add|delete|clear)/);
	});

	it("every allow return sits on a conditional line (no unconditional pass)", () => {
		const body = gate.slice(gate.indexOf("beforeTool"));
		const allowLines = body.split("\n").filter((l) => /return undefined|\? undefined/.test(l));
		expect(allowLines.length).toBeGreaterThanOrEqual(3); // whitelist + session + gate decision
		for (const line of allowLines) {
			expect(line.trim(), `allow must be conditional: ${line.trim()}`).toMatch(
				/^if \(READ_ONLY_WHITELIST\.has|^if \(session !== undefined|^return decision\.allow/,
			);
		}
	});
});
