/**
 * Durable documents for M2 bindings, M5 approvals, and M4 patrol — the
 * pi-durable-facing state layer. Lives under src/durable-ext/ (import gate).
 */
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";

/** Per-channel admission policy (P1-1.1). */
export type ChannelPolicy = {
	allowSenders: string[]; // open_id whitelist; default [ownerId] (F04)
	groupPolicy: "open" | "allowlist" | "disabled"; // F24
	mentionOnly: boolean; // groups default true; DMs always false
	muted: string[];
	dropBots: boolean;
	whenBusy: "followUp" | "steer" | "reject"; // R2-5: no "queue"
	model?: string;
}

export type ChannelBinding = {
	chatId: string; // primary key
	conversationId: number; // created at bind time
	cwd: string; // workspace; DM home = AGENT_HOME
	boardPath?: string; // rex-flow board for M4 patrol (additive field)
	/** Feishu thread root id → conversation. The channel root stays on conversationId. */
	threads?: Record<string, number>;
	policy: ChannelPolicy;
	createdAt: number;
}

/** Session-scope singleton holding the whole routing table. */
export const BindingsDoc = defineDoc<{ bindings: Record<string, ChannelBinding>; homeChatId: string }>({
	kind: "pots.bindings",
	version: 1,
	scope: "session",
	initial: () => ({ bindings: {}, homeChatId: "" }),
	checkpointWhen: () => false,
});

/** One approval request; family keyed by `${conversationId}:${callId}` (R2-2). */
export type ApprovalState = {
	toolName: string;
	digest: string; // exact-string identity of name+args (F21)
	argsPreview: string;
	conversationId: number;
	chatId: string;
	status: "pending" | "approved_once" | "approved_session" | "denied" | "timeout";
	createdAt: number;
	deadlineAt: number;
	decidedAt?: number;
	decidedBy?: string; // operator open_id
}

export const ApprovalDoc = defineDocFamily<ApprovalState, string>({
	kind: "pots.approval",
	version: 1,
	scope: "session",
	family: true,
	initial: (_key) => ({
		toolName: "",
		digest: "",
		argsPreview: "",
		conversationId: 0,
		chatId: "",
		status: "pending",
		createdAt: 0,
		deadlineAt: 0,
	}),
	checkpointWhen: () => false,
});

/** Index of pending approvals so the janitor and startup sweeps can find them. */
export const PendingApprovalsDoc = defineDoc<{ approvalIds: string[] }>({
	kind: "pots.pending-approvals",
	version: 1,
	scope: "session",
	initial: () => ({ approvalIds: [] }),
	checkpointWhen: () => false,
});

/** Session-scoped "Always" approvals: exact digest, 4h TTL (F21). Key: `${conversationId}:${toolName}:${digest}`. */
export const SessionApprovalsDoc = defineDocFamily<{ expiresAt: number; approvalId: string }, string>({
	kind: "pots.session-approvals",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ expiresAt: 0, approvalId: "" }),
	checkpointWhen: () => false,
});

/** Patrol state per bound workspace; key: chatId of the workspace channel. */
export const PatrolDoc = defineDocFamily<
	{
		lastHash: string;
		pendingDiff?: { diffId: string; summary: string };
		postedDiffIds: string[]; // bounded ring, newest last
	},
	string
>({
	kind: "pots.patrol",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ lastHash: "", postedDiffIds: [] }),
	checkpointWhen: () => false,
});

/** Deterministic key for the session-approval family. */
export function sessionApprovalKey(conversationId: number, toolName: string, digest: string): string {
	return `${conversationId}:${toolName}:${digest}`;
}

/** One outbound reply. `sent` is recorded only after the channel accepts it. */
export type DeliveryState = {
	requestId: string;
	submissionId: number;
	chatId: string;
	threadId: string;
	status: "pending" | "sent";
	updatedAt: number;
};

export const DeliveryDoc = defineDocFamily<DeliveryState, string>({
	kind: "pots.delivery",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ requestId: "", submissionId: 0, chatId: "", threadId: "", status: "pending", updatedAt: 0 }),
	checkpointWhen: () => false,
});

export const PendingDeliveriesDoc = defineDoc<{ requestIds: string[] }>({
	kind: "pots.pending-deliveries",
	version: 1,
	scope: "session",
	initial: () => ({ requestIds: [] }),
	checkpointWhen: () => false,
});

/** Local routine runs keep their own conversations, separate from Feishu threads. */
export type RoutineSession = { conversationId: number; cwd: string; chatId: string };

export const RoutineSessionsDoc = defineDoc<{ sessions: Record<string, RoutineSession> }>({
	kind: "pots.routine-sessions",
	version: 1,
	scope: "session",
	initial: () => ({ sessions: {} }),
	checkpointWhen: () => false,
});
