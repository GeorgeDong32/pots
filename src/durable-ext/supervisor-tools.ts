/**
 * M4 SupervisorModule — pi-durable side (P1-2). Read-only rex-flow board
 * tools (`replay: "safe"`, idempotent) plus the dispatch_note tool which only
 * appends a note file the orchestrator side picks up (RD-6: the agent never
 * writes the board itself). Also exposes channel_bind (admin, approved).
 */
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";

export interface SupervisorDeps {
	/** List known workspaces: [{cwd, boardPath, chatId}] (from bindings). */
	workspaces(): Promise<Array<{ cwd: string; boardPath?: string; chatId: string }>>;
	/** Summarize a board (status view); undefined when the board is missing. */
	boardStatus(boardPath: string): Promise<string | undefined>;
	/** List tasks of one run from a board. */
	boardTasks(boardPath: string, run: string): Promise<string>;
	/** Quick "has it stopped" check for a run/task (flow-watch --check-now wrapper). */
	watchRun(boardPath: string, run: string, task: string): Promise<string>;
	/** Append a dispatch note under the project dir (never touches board.json). */
	dispatchNote(boardPath: string, run: string, task: string, text: string): Promise<string>;
	/** Bind or rebind a channel (calls back into substrate/bridge). */
	bindChannel(input: { chatId: string; cwd: string; boardPath?: string }): Promise<string>;
}

export function createSupervisorExtension(deps: SupervisorDeps): Extension {
	const boardStatusTool = defineTool({
		name: "board_status",
		description:
			"Read-only status summary of a rex-flow board (runs, stages, task counts). " +
			"Omit boardPath to list every known workspace with its summary line.",
		parameters: obj({ boardPath: opt(str()) }),
		replay: "safe",
		execute: async (args) => {
			if (args.boardPath === undefined) {
				const ws = await deps.workspaces();
				const lines = await Promise.all(
					ws.map(async (w) =>
						w.boardPath ? `- ${w.cwd} (${w.boardPath}): ${await deps.boardStatus(w.boardPath)}` : `- ${w.cwd}: no board`,
					),
				);
				return { output: [{ type: "text", text: lines.join("\n") || "no workspaces bound" }] };
			}
			const summary = await deps.boardStatus(args.boardPath);
			return {
				output: [
					{ type: "text", text: summary ?? `board not found: ${args.boardPath}` },
				],
			};
		},
	});

	const boardTasksTool = defineTool({
		name: "board_tasks",
		description: "Read-only task list of one run from a rex-flow board (id, status, rework_count).",
		parameters: obj({ boardPath: str(), run: str() }),
		replay: "safe",
		execute: async (args) => ({
			output: [{ type: "text", text: await deps.boardTasks(args.boardPath, args.run) }],
		}),
	});

	const watchRunTool = defineTool({
		name: "watch_run",
		description:
			"Check whether a worker tab for a board task has stopped (flow-watch wrapper, quick check). " +
			"Returns the observed state; it does not judge correctness.",
		parameters: obj({ boardPath: str(), run: str(), task: str() }),
		replay: "safe",
		execute: async (args) => ({
			output: [{ type: "text", text: await deps.watchRun(args.boardPath, args.run, args.task) }],
		}),
	});

	const workspaceListTool = defineTool({
		name: "workspace_list",
		description: "List bound workspaces (cwd, board path, channel).",
		parameters: obj({}),
		replay: "safe",
		execute: async () => {
			const ws = await deps.workspaces();
			return {
				output: [
					{ type: "text", text: ws.map((w) => `${w.cwd}\tboard=${w.boardPath ?? "-"}\tchat=${w.chatId}`).join("\n") },
				],
			};
		},
	});

	const dispatchNoteTool = defineTool({
		name: "dispatch_note",
		description:
			"Append a note for a board task (re-dispatch hint, question, context). The orchestrator " +
			"side reads it; this never modifies the board itself. Not replay-safe on purpose.",
		parameters: obj({ boardPath: str(), run: str(), task: str(), text: str() }),
		execute: async (args) => ({
			output: [
				{ type: "text", text: await deps.dispatchNote(args.boardPath, args.run, args.task, args.text) },
			],
		}),
	});

	const channelBindTool = defineTool({
		name: "channel_bind",
		description:
			"Bind or rebind a Feishu chat to a workspace (cwd) with optional rex-flow board. " +
			"Owner action; goes through approval (changing the routing table changes the security boundary).",
		parameters: obj({
			chatId: str(),
			cwd: str(),
			boardPath: opt(str()),
			maxTurns: opt(num()),
		}),
		execute: async (args) => ({
			output: [
				{
					type: "text",
					text: await deps.bindChannel({
						chatId: args.chatId,
						cwd: args.cwd,
						boardPath: args.boardPath,
					}),
				},
			],
		}),
	});

	return defineExtension({
		name: "pots-supervisor",
		tools: [boardStatusTool, boardTasksTool, watchRunTool, workspaceListTool, dispatchNoteTool, channelBindTool],
	});
}
