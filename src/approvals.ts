/**
 * M5 ApprovalModule — app-side manager (P1-3, r1 redesign).
 *
 * The beforeTool hook (src/durable-ext/approval-gate.ts) delegates here.
 * This manager owns the durable state machine: pending ApprovalDoc (written
 * via substrate.commit — HookApi has no commit, R2-1), the Feishu card,
 * the in-process await, crash re-entry (re-send the same approvalId, F08),
 * owner-only verdicts (F03), the 10-minute timeout sweep, and "Always"
 * session approvals (4h TTL, exact digest, F21).
 */
import type { CardAction, Channel } from "./channel.js";
import type { Logger } from "./log.js";
import { callDigest, sensitivePathHit, type ApprovalGate, type GateCall, type GateDecision } from "./durable-ext/approval-gate.js";
import type { ApprovalState, Substrate } from "./substrate.js";

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000; // P1-3.2 default 10min → denied
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface ApprovalCardData {
	approvalId: string;
	toolName: string;
	argsPreview: string;
	deadlineAt: number;
}

export interface ApprovalManagerDeps {
	channel: Channel;
	ownerOpenId: string;
	logger: Logger;
	timeoutMs?: number;
}

export class ApprovalManager implements ApprovalGate {
	private substrate: Substrate | undefined;
	private readonly waiters = new Map<string, (decision: GateDecision) => void>();
	private sweepTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly deps: ApprovalManagerDeps) {}

	/** Wiring: the substrate is opened with extensions that reference this manager. */
	attach(substrate: Substrate): void {
		this.substrate = substrate;
	}

	start(): void {
		void this.sweep(); // startup sweep: crash-orphaned pendings past deadline
		this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
	}

	stop(): void {
		if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
		for (const resolve of this.waiters.values()) resolve({ allow: false, block: "daemon shutting down" });
		this.waiters.clear();
	}

	async request(call: GateCall, conversationId: number): Promise<GateDecision> {
		const substrate = this.requireSubstrate();
		// Sensitive paths never reach this manager in production (hook refuses first);
		// re-checked here so the manager is safe under any wiring.
		if (sensitivePathHit(call)) return { allow: false, block: "sensitive path: denied" };

		const digest = callDigest(call);
		// Stable across crash reruns: the same conversation + same call replays identically.
		const approvalId = `${conversationId}:${digestHash(digest)}`;
		const existing = await substrate.getApproval(approvalId);

		if (existing !== undefined) {
			if (existing.status !== "pending") return this.verdictOf(existing.status);
			if (Date.now() >= existing.deadlineAt) return { allow: false, block: "approval timed out" };
			// Crash re-entry (P1-3.3.3): re-send the card with the SAME approvalId, rebuild the await.
			await this.sendCard({ ...existing, approvalId });
			return this.awaitVerdict(approvalId);
		}

		const chatId = (await substrate.chatOfConversation(conversationId)) ?? "";
		const state: ApprovalState & { approvalId: string } = {
			approvalId,
			toolName: call.name,
			digest,
			argsPreview: JSON.stringify(call.arguments).slice(0, 400),
			conversationId,
			chatId,
			status: "pending",
			createdAt: Date.now(),
			deadlineAt: Date.now() + (this.deps.timeoutMs ?? APPROVAL_TIMEOUT_MS),
		};
		const created = await substrate.createApprovalPending(state);
		if (created) {
			// F09: the conversation stays busy while we await — tell the channel explicitly.
			await this.sendCard(state);
		}
		return this.awaitVerdict(approvalId);
	}

	/** Card-action ingress (F03: owner-only; others are audited and ignored). */
	async onCardAction(action: CardAction): Promise<void> {
		const substrate = this.requireSubstrate();
		if (action.operatorOpenId !== this.deps.ownerOpenId) {
			this.deps.logger.warn("approval card clicked by non-owner; ignored", {
				actionId: action.actionId,
				operatorOpenId: action.operatorOpenId,
				approvalId: action.value,
			});
			return;
		}
		const approvalId = action.value;
		if (approvalId === undefined || !approvalId) return;
		const state = await substrate.getApproval(approvalId);
		if (state === undefined || state.status !== "pending") return;

		const status: ApprovalState["status"] =
			action.actionId === "approve_once"
				? "approved_once"
				: action.actionId === "approve_session"
					? "approved_session"
					: action.actionId === "deny"
						? "denied"
						: "pending";
		if (status === "pending") return; // unrelated button

		// R2-3: only a pending approval is written (first writer wins).
		const won = await substrate.decideApproval(approvalId, status, action.operatorOpenId);
		if (!won) {
			this.resolveWaiter(approvalId, { allow: false, block: "approval already decided" });
			return;
		}
		if (status === "approved_session") {
			await substrate.setSessionApproval(state.conversationId, state.toolName, state.digest, approvalId);
		}
		const note =
			status === "approved_once"
				? "✅ 已批准（仅本次）"
				: status === "approved_session"
					? "✅ 已批准（本会话 4h 内同命令免审）"
					: "❌ 已拒绝";
		try {
			await this.deps.channel.postText(state.chatId, note);
		} catch {
			// Best effort.
		}
		this.resolveWaiter(approvalId, this.verdictOf(status));
	}

	/** Timeout sweep: pending past deadline → denied + notify (P1-3.3.4). */
	async sweep(): Promise<void> {
		const substrate = this.requireSubstrate();
		for (const pending of await substrate.pendingApprovals()) {
			if (pending.deadlineAt > Date.now()) continue;
			const won = await substrate.decideApproval(pending.approvalId, "timeout", "janitor");
			if (!won) continue;
			this.deps.logger.info("approval timed out", { approvalId: pending.approvalId });
			try {
				await this.deps.channel.postText(pending.chatId, "⏱ 审批超时未决 → 已拒绝");
			} catch {
				// Best effort.
			}
			this.resolveWaiter(pending.approvalId, { allow: false, block: "approval timed out" });
		}
	}

	private async sendCard(state: ApprovalState & { approvalId: string }): Promise<void> {
		try {
			await this.deps.channel.postCard(state.chatId, {
				approvalId: state.approvalId,
				toolName: state.toolName,
				argsPreview: state.argsPreview,
				deadlineAt: state.deadlineAt,
			});
		} catch (error) {
			this.deps.logger.error("approval card send failed", {
				approvalId: state.approvalId,
				error: (error as Error).message,
			});
		}
	}

	private awaitVerdict(approvalId: string): Promise<GateDecision> {
		return new Promise<GateDecision>((resolve) => {
			this.waiters.set(approvalId, resolve);
		});
	}

	private resolveWaiter(approvalId: string, decision: GateDecision): void {
		const waiter = this.waiters.get(approvalId);
		this.waiters.delete(approvalId);
		waiter?.(decision);
	}

	private verdictOf(status: ApprovalState["status"]): GateDecision {
		return status === "approved_once" || status === "approved_session"
			? { allow: true }
			: { allow: false, block: `approval ${status}` };
	}

	private requireSubstrate(): Substrate {
		if (this.substrate === undefined) throw new Error("ApprovalManager not attached to a substrate");
		return this.substrate;
	}
}

/** Short stable hash of the digest for approval ids (display only, not security). */
function digestHash(digest: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < digest.length; i++) {
		h ^= digest.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16) + digest.length.toString(16);
}
