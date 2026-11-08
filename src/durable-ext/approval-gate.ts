/**
 * M5 ApprovalModule — pi-durable side (P1-3). The beforeTool hook implements
 * deny-by-default (F02/F22): everything outside the read-only whitelist goes
 * through the approval manager; sensitive paths are hard-denied before any
 * approval. The hook only awaits a verdict; all document writes happen in the
 * app-side manager via `substrate.commit` (R2-1: HookApi has no commit).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	ToolTask,
	defineExtension,
	hook,
	type Extension,
	type HookApi,
	type ToolHookCall,
} from "@earendil-works/pi-durable";
import { SessionApprovalsDoc, sessionApprovalKey } from "./docs.ts";

export interface GateDecision {
	allow: boolean;
	block?: string;
}

/** The verdict source the hook delegates to (implemented by src/approvals.ts). */
export interface ApprovalGate {
	/** Full approval flow: pending doc → card → await → verdict (crash-reentrant). */
	request(call: GateCall, conversationId: number): Promise<GateDecision>;
}

export interface GateCall {
	name: string;
	arguments: Record<string, unknown>;
	callId: string;
}

/** Tools allowed without approval (P1-3.1 + P2-1.3): read-only monitors plus the
 * memory tools, which are path-jailed by construction (memory_write only
 * appends under <agentHome>/memory; consolidate/apply run through the
 * cc-core store validator under the layer lock). */
const READ_ONLY_WHITELIST = new Set([
	"read",
	"board_status",
	"board_tasks",
	"watch_run",
	"workspace_list",
	"memory_write",
	"session_recall",
	"memory_consolidate",
]);

/**
 * Sensitive paths refused for ANY tool, ANY verdict — never enter approval
 * (P1-3.1). Patterns are matched against the raw argument JSON.
 */
export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
	/\.ssh/i,
	/keychain/i,
	/credentials?\.json/i,
	/\.aws/i,
	/\.gnupg/i,
	/harness\.sqlite/i,
	/\.pi-larkd\/daemon\.lock/i,
	/id_rsa/i,
	/id_ed25519/i,
	/\.env\b/i,
];

export function sensitivePathHit(call: GateCall): boolean {
	const blob = JSON.stringify(call.arguments ?? {});
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(blob) || pattern.test(call.name));
}

/** Stable exact-string identity: same name + same args = same digest (F21). */
export function callDigest(call: GateCall): string {
	const stable = (value: unknown): string => {
		if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
		if (value !== null && typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
			return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
		}
		return JSON.stringify(value) ?? "null";
	};
	return `${call.name}:${stable(call.arguments)}`;
}

/** The M5 extension: installed once; every conversation selecting it is gated. */
export function createApprovalGateExtension(gate: ApprovalGate): Extension {
	return defineExtension({
		name: "pi-larkd-approval-gate",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (
					call: ToolHookCall,
					api: HookApi,
				): Promise<{ block?: string } | undefined> => {
					const gateCall: GateCall = {
						name: call.name,
						arguments: (call.arguments ?? {}) as Record<string, unknown>,
						callId: call.id,
					};
					// 1. Hard refuse: sensitive paths never reach approval.
					if (sensitivePathHit(gateCall)) {
						return { block: "sensitive path: denied without approval" };
					}
					// 2. Read-only whitelist passes.
					if (READ_ONLY_WHITELIST.has(gateCall.name)) return undefined;
					// 3. Session approval fast path (Always, 4h TTL, exact digest).
					const digest = callDigest(gateCall);
					const key = sessionApprovalKey(Number(api.conversationId), gateCall.name, digest);
					const session = await api.snapshot(SessionApprovalsDoc, key, BACKGROUND_CONTEXT);
					if (session !== undefined && session.expiresAt > Date.now()) return undefined;
					// 4. Full approval flow (manager writes docs app-side; hook awaits).
					const decision = await gate.request(gateCall, Number(api.conversationId));
					return decision.allow ? undefined : { block: decision.block ?? "denied by approval" };
				},
			}),
		],
	});
}
