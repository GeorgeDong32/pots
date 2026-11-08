/**
 * The SINGLE import site of the cc-core memory semantic core
 * (`../Pi-Extension/pi-claude-code-core/extensions/memory/`). The core is
 * pi-agnostic pure TS and is consumed IN PLACE — never copied (P2-2; the
 * mechanics and the file:-dependency infeasibility are recorded in
 * DEVIATIONS.md D-9). cc-core is the source of truth: when it changes in
 * ways that touch these exports, update the mapping in DEVIATIONS/P2 notes.
 *
 * Port mapping (P2-2 hook table):
 *   session_start reconcile      → daemon startup reindexBoth() here
 *   conversation cwd binding     → reindexAt() on bind (supervisor deps)
 *   registerTool session_recall  → durable-ext/memory-ext.ts (wrapped 1:1)
 *   registerTool memory_consolidate → durable-ext/memory-ext.ts (wrapped 1:1)
 *   turn_end auto-consolidate    → durable-ext/consolidate-task.ts (5min debounce)
 *   tool_call guard              → M5 gate sensitive paths + memory_write path jail
 *   user layer ~/.pi/agent/memory shared with pi (F25): all read-modify-write
 *   cycles run under acquireLayerLock, snapshot fallback on failure.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { applyMemoryOps, type MemoryOp, type OpsOutcome } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/store.ts";
import { acquireLayerLock, type LayerLock } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/store.ts";
import { layerStats, type LayerStats } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/store.ts";
import { completeMemoryOps, completeText, type RegistryLike, type TextCompletion } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/llm.ts";
import { runConsolidation } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/consolidate.ts";
import { reindex } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/writer.ts";
import { scanMemoryDir, type MemoryEntry } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/memdir.ts";
import { resolveMemoryPaths, type MemoryPaths } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/paths.ts";
import { sessionRecall, type RecallOptions, type RecallResult } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/session-recall.ts";

export type { MemoryOp, OpsOutcome, LayerStats, MemoryEntry, MemoryPaths, RegistryLike, TextCompletion, RecallOptions, RecallResult };

export { applyMemoryOps, completeMemoryOps, completeText, runConsolidation, reindex, scanMemoryDir, resolveMemoryPaths, sessionRecall, layerStats };

/** RegistryLike over pi-larkd's single provider (Keychain-held key). */
export function registryLike(getKey: () => string | undefined, providerId: string): RegistryLike {
	return {
		getApiKeyAndHeaders: async (model: Model<Api>) =>
			model.provider === providerId
				? { ok: true as const, apiKey: getKey() }
				: { ok: false as const, error: `unknown provider ${model.provider}` },
	};
}

/** Run a read-modify-write cycle on a memory layer under its cross-process lock (F25). */
export async function withLayerLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T | undefined> {
	const lock: LayerLock | null = acquireLayerLock(dir);
	if (lock === null) return undefined; // someone else holds it; skip, next cycle converges
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

/** Reconcile both layers for a cwd (startup + bind-time). */
export function reindexBoth(cwd: string, home?: string): { project: ReturnType<typeof reindex>; user: ReturnType<typeof reindex> } {
	const paths = resolveMemoryPaths(cwd, home);
	return {
		project: safeReindex(paths.memoryDir),
		user: safeReindex(paths.userMemoryDir),
	};
}

function safeReindex(dir: string): ReturnType<typeof reindex> {
	try {
		return reindex(dir);
	} catch {
		return { entries: [], skipped: 0, rewrote: false };
	}
}

/** Static index header within a byte budget (DP-P2-1 mode b; see DEVIATIONS). */
export function indexHeader(cwd: string | undefined, maxBytes: number, home?: string): string {
	const paths = resolveMemoryPaths(cwd ?? process.cwd(), home);
	const sections: string[] = [];
	let budget = maxBytes;
	const addLayer = (label: string, dir: string): void => {
		let scanned: { entries: MemoryEntry[]; skipped: number };
		try {
			scanned = scanMemoryDir(dir);
		} catch {
			return; // layer absent
		}
		if (scanned.entries.length === 0) return;
		const lines = scanned.entries
			.slice()
			.sort((a, b) => Number(b.pinned) - Number(a.pinned))
			.map((e) => `- [${e.title}] ${e.description}${e.pinned ? " 📌" : ""}`);
		const header = `# ${label} memory\n`;
		const body = lines.join("\n").slice(0, Math.max(0, budget - header.length - 1));
		if (body.length === 0) return;
		sections.push(header + body);
		budget -= header.length + body.length + 2;
		if (budget <= 0) return;
	};
	addLayer("user (shared with pi)", paths.userMemoryDir);
	addLayer("project", paths.memoryDir);
	return sections.join("\n\n");
}
