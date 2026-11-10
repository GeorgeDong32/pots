#!/usr/bin/env node
/**
 * `pots status` — prints the daemon's status snapshot (~/.pots/status.json,
 * refreshed every 60s by the daemon). The daemon owns the SQLite file, so the
 * CLI never opens the database (one owner per storage; the file is the seam).
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const path = process.argv[2] ?? join(homedir(), ".pots", "status.json");
if (!existsSync(path)) {
	console.error("pots: no status snapshot (is the daemon running?) at", path);
	process.exit(1);
}
const status = JSON.parse(readFileSync(path, "utf8"));
const staleMs = Date.now() - Date.parse(status.ts);
const stale = staleMs > 3 * 60 * 1000;
console.log(`pots status  (snapshot ${stale ? "STALE" : "fresh"}, ${Math.round(staleMs / 1000)}s old)`);
console.log(`  pid:        ${status.pid}`);
console.log(`  uptime:     ${Math.round((status.uptimeMs ?? 0) / 3600000)}h`);
console.log(`  convs:      ${(status.conversations ?? []).length} — ${(status.conversations ?? []).join(", ")}`);
console.log(`  lastError:  ${status.lastError}`);
const models = status.usage?.models ?? {};
for (const [key, value] of Object.entries(models)) {
	console.log(`  usage[${key}]: ${JSON.stringify(value)}`);
}
if (stale) {
	console.log("⚠️ snapshot stale >3min — daemon may be dead (dead-man heartbeat should also be silent)");
	process.exit(2);
}
