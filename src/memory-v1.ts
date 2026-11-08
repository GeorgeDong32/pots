/**
 * App-side wiring of the cc-core semantic core into the M6 extension's v1
 * deps (P2-2). All read-modify-write cycles on the shared user layer run
 * under the layer lock (F25); pi-side writers take the same lock, so the
 * two processes cannot interleave a consolidation with a write batch.
 */
import { resolveMemoryPaths } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/paths.ts";
import { needsConsolidation, runConsolidation } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/consolidate.ts";
import { INDEX_MAX_BYTES } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/writer.ts";
import { USER_INDEX_MAX } from "../../Pi-Extension/pi-claude-code-core/extensions/memory/policy.ts";
import type { MemoryV1Deps } from "./durable-ext/memory-ext.ts";
import { indexHeader, layerStats, sessionRecall } from "./memcore.ts";

export function createMemoryV1Deps(): MemoryV1Deps {
	const pathsOf = (cwd: string | undefined) => resolveMemoryPaths(cwd ?? process.cwd());

	return {
		indexHeader: (cwd, maxBytes) => indexHeader(cwd, maxBytes),
		async recall(query, cwd) {
			const result = await sessionRecall({ query, cwd: cwd ?? process.cwd() });
			if (result.hits.length === 0) {
				return `no hits (scanned ${result.scannedFiles} files, ${result.bytesScanned}B)`;
			}
			return result.hits
				.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`)
				.join("\n")
				.concat(
					result.budgetExhausted ? "\n(scan hit the budget; narrow the query)" : "",
				);
		},
		async consolidate(layer, cwd, writes, deletes) {
			const paths = pathsOf(cwd);
			const dir = layer === "user" ? paths.userMemoryDir : paths.memoryDir;
			// runConsolidation takes the cross-process layer lock itself (F25:
			// pi-side consolidation takes the same lock — the two never interleave).
			const result = runConsolidation(
				dir,
				writes as Parameters<typeof runConsolidation>[1],
				deletes as Parameters<typeof runConsolidation>[2],
				layer === "user",
			);
			return result.ok
				? `ok: ${result.written} written, ${result.deleted} deleted (${result.beforeBytes}B → ${result.afterBytes}B)`
				: `rejected: ${result.message}`;
		},
		overBudget(cwd) {
			const paths = pathsOf(cwd);
			const out: Array<{ layer: "user" | "project"; reason: string }> = [];
			for (const [layer, dir, cap] of [
				["project", paths.memoryDir, INDEX_MAX_BYTES],
				["user", paths.userMemoryDir, USER_INDEX_MAX],
			] as const) {
				try {
					const stats = layerStats(dir);
					const reason = needsConsolidation(stats, cap);
					if (reason !== null) out.push({ layer, reason });
				} catch {
					// absent layer
				}
			}
			return out;
		},
	};
}
