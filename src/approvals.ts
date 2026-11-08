/**
 * M5 ApprovalModule — P0 placeholder.
 *
 * P0's registry installs only the `read` tool, so no gate is reachable in
 * practice. The P0 stance is still deny-by-default: this module's single
 * exported verdict function denies everything except the read-only whitelist.
 * P1 replaces this file with the full card-driven ApprovalDoc state machine
 * (P1-3): deny-by-default interception, owner-only card actions, crash re-entry.
 */

/** Tools allowed without approval in P0: read only (P0-2.2, F05). */
const P0_READ_ONLY_WHITELIST = new Set(["read"]);

export type GateVerdict = { allow: true } | { allow: false; reason: string };

/** P0 gate: everything outside the read-only whitelist is denied outright. */
export function gateToolCall(toolName: string): GateVerdict {
	if (P0_READ_ONLY_WHITELIST.has(toolName)) return { allow: true };
	return { allow: false, reason: `tool "${toolName}" is not in the read-only whitelist (P0)` };
}
