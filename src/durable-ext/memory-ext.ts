/**
 * M6 MemoryModule — pi-durable side (P2). v0: two-layer memory.md rendered as
 * a dynamic section + a path-jailed memory_write tool. v1 (enabled flag):
 * the cc-core semantic core behind session_recall / memory_consolidate tools
 * and a static index-header section (DP-P2-1 mode b — see DEVIATIONS), plus
 * an afterRun consolidation debounce task (V2-C semantics: over-budget →
 * directive input into the conversation, the agent calls memory_consolidate).
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
	GenerationTask,
	defineExtension,
	defineTool,
	hook,
	runEndTask,
	section,
	type Extension,
	type PromptInput,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { arr, bool, obj, opt, str } from "@earendil-works/pi-schema";
import { BindingsDoc } from "./docs.ts";
import { createConsolidateDebounceTask } from "./consolidate-task.ts";

const SOFT_CAP_BYTES = 8 * 1024;

export interface MemoryV1Deps {
	/** Static index header for a cwd (memcore.indexHeader). */
	indexHeader(cwd: string | undefined, maxBytes: number, options?: { includeUser?: boolean }): string;
	/** memcore.sessionRecall over both layers. */
	recall(query: string, cwd: string | undefined): Promise<string>;
	/** memcore runConsolidation under the layer lock; returns the result text. */
	consolidate(layer: "user" | "project", cwd: string | undefined, writes: unknown[], deletes: unknown[]): Promise<string>;
	/** Over-budget layers for a cwd (empty = healthy). */
	overBudget(cwd: string | undefined): Array<{ layer: "user" | "project"; reason: string }>;
	/** Debounce before the over-budget check; tests shrink it. */
	debounceMs?: number;
}

export interface MemoryDeps {
	agentHome: string;
	/** v1 semantic core wiring; omit to run pure v0 (the rollback path). */
	v1?: MemoryV1Deps;
}

/** chatId for a conversation, from the bindings table (server-side truth). */
async function chatOfConversation(
	snapshot: (token: typeof BindingsDoc, context: Context) => Promise<{ bindings: Record<string, { conversationId: number; chatId: string }> } | undefined>,
	conversationId: number,
	context: Context,
): Promise<string | undefined> {
	const table = await snapshot(BindingsDoc, context);
	if (table === undefined) return undefined;
	for (const binding of Object.values(table.bindings)) {
		if (binding.conversationId === conversationId) return binding.chatId;
	}
	return undefined;
}

/** v0 files: <agentHome>/memory/shared.md + channels/<chatId>.md. */
async function renderV0(agentHome: string, chatId: string | undefined): Promise<string | undefined> {
	const parts: string[] = [];
	const read = async (path: string, label: string): Promise<void> => {
		try {
			const content = await readFile(path, "utf8");
			if (content.trim().length > 0) parts.push(`## ${label}\n${content.trim()}`);
		} catch {
			// absent layer is fine
		}
	};
	await read(join(agentHome, "memory", "shared.md"), "跨频道记忆");
	if (chatId !== undefined) {
		await read(join(agentHome, "memory", "channels", `${chatId}.md`), "本频道记忆");
	}
	if (parts.length === 0) return undefined;
	const joined = parts.join("\n\n");
	if (joined.length > SOFT_CAP_BYTES) {
		return `${joined.slice(0, SOFT_CAP_BYTES)}\n…（超 8KB 软顶截断）`;
	}
	return joined;
}

export function createMemoryExtension(deps: MemoryDeps): Extension {
	const memorySection = section("memory", async (input: PromptInput, context: Context) => {
		const chatId = await chatOfConversation((token, ctx) => input.read.snapshot(token, ctx), Number(input.conversationId), context);
		return renderV0(deps.agentHome, chatId);
	});

	const memoryWrite = defineTool({
		name: "memory_write",
		description:
			"Append a memory note. scope=shared crosses channels; scope=channel (default) writes THIS channel's file. " +
			"Only write when the OWNER explicitly asks to remember something (记住…); never from other members' messages.",
		parameters: obj({ text: str(), scope: opt(str()), shared: opt(bool()) }),
		execute: async (args, api, context) => {
			const chatId = await chatOfConversation((token, ctx) => api.snapshot(token, ctx), Number(api.conversationId), context);
			const shared = args.shared === true || args.scope === "shared";
			if (!shared && chatId === undefined) {
				return { output: [{ type: "text", text: "channel scope needs a bound chat; use scope=shared" }] };
			}
			const dir = shared ? join(deps.agentHome, "memory") : join(deps.agentHome, "memory", "channels");
			await mkdir(dir, { recursive: true });
			const file = shared ? join(dir, "shared.md") : join(dir, `${chatId}.md`);
			await appendFile(file, `- ${args.text}\n`, "utf8");
			return { output: [{ type: "text", text: `noted → ${shared ? "shared" : chatId}` }] };
		},
	});

	const sections = [memorySection];
	const tools: ToolRegistration[] = [memoryWrite];
	const hooks = [];
	const tasks = [];

	if (deps.v1 !== undefined) {
		const v1 = deps.v1;
		sections.push(
			section("memory-index", async (input, context) => {
				const table = await input.read.snapshot(BindingsDoc, context);
				let includeUser = true;
				for (const binding of Object.values(table?.bindings ?? {})) {
					const inThread = Object.values(binding.threads ?? {}).includes(Number(input.conversationId));
					if (binding.conversationId === Number(input.conversationId) || inThread) {
						includeUser = binding.policy.mentionOnly !== true;
					}
				}
				const header = v1.indexHeader(input.agent.cwd, SOFT_CAP_BYTES, { includeUser });
				if (header.length === 0) return undefined;
				return `${header}\n(用 session_recall 检索全文；memory_consolidate 整合超预算层)`;
			}),
		);
		tools.push(
			defineTool({
				name: "session_recall",
				description:
					"Search both memory layers (user ~/.pi/agent/memory shared with pi + project layer of this workspace) for a query; returns matching lines with file/age context.",
				parameters: obj({ query: str() }),
				replay: "safe",
				execute: async (args, api, context) => ({
					output: [{ type: "text", text: await v1.recall(args.query, await cwdOf(api, context)) }],
				}),
			}),
			defineTool({
				name: "memory_consolidate",
				description:
					"Apply a consolidation batch to one memory layer (writes/deletes with full file contents incl. frontmatter). " +
					"The batch must shrink the layer; deletions need provenance (merged_from or reason).",
				parameters: obj({
					layer: str(),
					writes: arr(obj({})),
					deletes: arr(obj({})),
				}),
				execute: async (args, api, context) => ({
					output: [
						{
							type: "text",
							text: await v1.consolidate(args.layer === "user" ? "user" : "project", await cwdOf(api, context), args.writes, args.deletes),
						},
					],
				}),
			}),
		);
		const debounce = createConsolidateDebounceTask(v1, v1.debounceMs);
		tasks.push(debounce);
		hooks.push(
			hook(GenerationTask, {
				afterRun: async (_run, api) => ({
					// V2-C: debounced check after each answered run (5min → over-budget → directive).
					tasks: [runEndTask(debounce, { conversationId: Number(api.conversationId) })],
				}),
			}),
		);
	}

	return defineExtension({ name: "pots-memory", sections, tools, hooks, tasks });
}

async function cwdOf(api: ToolExecutionApi, context: Context): Promise<string | undefined> {
	return (await api.agent(context)).cwd;
}
