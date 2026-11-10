/**
 * M4 SupervisorModule — app side (P1-2). Implements the tool deps the
 * durable-ext supervisor tools call, plus patrol wiring.
 *
 * Read discipline (RD-6/B7): the board file is read with plain fs reads and
 * `flow-board <board> status` ONLY. The one write this module performs is
 * dispatch notes, which go to the project dir's dispatch/ tree — never to
 * board.json. The B7 static gate (test/b7-static.test.ts) asserts this.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SupervisorDeps } from "./durable-ext/supervisor-tools.ts";
import type { Logger } from "./log.ts";
import type { Substrate } from "./substrate.ts";

const execFileAsync = promisify(execFile);

interface BoardTask {
	id?: string;
	status?: string;
	rework_count?: number;
	note?: string;
}

interface Board {
	deploy?: { repo?: string; project_dir?: string; test_cmd?: string };
	runs?: Array<{ name?: string; stage?: string }>;
	tasks?: BoardTask[];
	gates?: Array<{ id?: string; open?: boolean }>;
}

/** Parse a board file; throws for the caller to surface as a tool error result. */
async function readBoardJson(boardPath: string): Promise<Board> {
	return JSON.parse(await readFile(boardPath, "utf8")) as Board;
}

/** Injected so tests can stub fs and the flow-board binary. */
export interface SupervisorOptions {
	flowWatchBin?: string;
	logger: Logger;
}

export function createSupervisor(substrate: Substrate, options: SupervisorOptions): SupervisorDeps {
	const flowWatchBin = options.flowWatchBin ?? `${process.env.HOME ?? ""}/.rex-flow/bin/flow-watch`;

	const run = async (bin: string, args: string[]): Promise<string> => {
		try {
			const { stdout } = await execFileAsync(bin, args, { timeout: 30_000 });
			return stdout.trim();
		} catch (error) {
			return `error: ${(error as Error).message}`;
		}
	};

	const boardOrNull = async (boardPath: string): Promise<string | null> => {
		try {
			return await readFile(boardPath, "utf8");
		} catch {
			return null;
		}
	};

	return {
		async workspaces() {
			const { bindings } = await substrate.bindings();
			return Object.values(bindings).map((b) => ({
				cwd: b.cwd,
				boardPath: b.boardPath,
				chatId: b.chatId,
			}));
		},
		async boardStatus(boardPath) {
			const content = await boardOrNull(boardPath);
			if (content === null) return undefined;
			return summarizeBoard(boardPath, content);
		},
		async boardTasks(boardPath, runName) {
			try {
				const board = await readBoardJson(boardPath);
				const rows = (board.tasks ?? []).filter((t) => (t.id ?? "").startsWith(`${runName}/`));
				if (rows.length === 0) return `no tasks for run ${runName}`;
				return rows.map((t) => `${t.id}: ${t.status ?? "?"}${t.rework_count ? ` (rework×${t.rework_count})` : ""}`).join("\n");
			} catch (error) {
				return `error: ${(error as Error).message}`;
			}
		},
		async watchRun(boardPath, runName, task) {
			// Quick check only: the agent judges results itself after the check.
			return run(flowWatchBin, ["--board", boardPath, "--run", runName, "--task", task, "--check-now", "--timeout", "5"]);
		},
		async dispatchNote(boardPath, runName, task, text) {
			// Notes go under the project dir's dispatch tree; board.json stays untouched.
			let projectDir = dirname(boardPath);
			try {
				const board = await readBoardJson(boardPath);
				if (board.deploy?.project_dir) projectDir = board.deploy.project_dir;
			} catch {
				// Fall back to the board's directory.
			}
			const dir = join(projectDir, "dispatch", runName);
			await mkdir(dir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const file = join(dir, `note-${task}-${stamp}.md`);
			await appendFile(file, `# note ${runName}/${task}\n\n${text}\n\n(from pots super-agent)\n`, "utf8");
			return `note appended: ${file}`;
		},
		async bindChannel(input) {
			return substrate.bindChannel({ ...input, isGroup: true });
		},
	};
}

/** Provenance-labelled summary of a board snapshot (F27: summary, not raw content). */
export function summarizeBoard(boardPath: string, content: string): string {
	try {
		const board = JSON.parse(content) as Board;
		const runs = (board.runs ?? []).map((r) => `${r.name ?? "?"}:${r.stage ?? "?"}`).join(", ") || "none";
		const tasks = board.tasks ?? [];
		const byStatus = new Map<string, number>();
		for (const t of tasks) byStatus.set(t.status ?? "?", (byStatus.get(t.status ?? "?") ?? 0) + 1);
		const taskSummary = [...byStatus.entries()].map(([s, n]) => `${s}×${n}`).join(", ") || "none";
		const openGates = (board.gates ?? []).filter((g) => g.open).length;
		const terminal = tasks
			.filter((t) => t.status === "merged" || t.status === "blocked")
			.map((t) => `${t.id}→${t.status}`)
			.slice(-5)
			.join(", ");
		return [
			`runs: ${runs}`,
			`tasks: ${taskSummary}`,
			`open gates: ${openGates}`,
			terminal ? `recent terminal: ${terminal}` : "",
		]
			.filter(Boolean)
			.join(" · ");
	} catch {
		return `board ${boardPath}: unparseable content (hash changed)`;
	}
}
