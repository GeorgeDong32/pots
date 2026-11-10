/**
 * M3 SubstrateModule — the single import point of `@earendil-works/pi-durable`
 * (ESLint-enforced; see eslint.config.js). Version pin: pi-durable 1.5.0 exact.
 * Upgrading pi-durable must only touch this file (plus src/durable-ext/).
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createModels, createProvider, type Models, type Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import {
	AssistantEntry,
	Harness,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	configure,
	createRegistry,
	defineDocFamily,
	defineExtension,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type EntryId,
	type SubmissionId,
	type Extension,
	type SessionEnd,
	type Storage,
	type Submission,
	type SubmissionDraft,
	type Tx,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";

export type {
	Conversation,
	ConversationView,
	Submission,
	SubmissionDraft,
	Tx,
	SessionEnd,
	EntryId,
	SubmissionId,
	Extension,
};

/** What a bridge pump needs from a settled submission. */
export type SettledInfo =
	| { status: "done"; answer?: EntryId }
	| { status: "unanswered"; reason: string };

/** Seam-level awaitable for a submission (no chord Context leaks out). */
export interface SubmissionHandle {
	wait(): Promise<SettledInfo>;
}

/** Where the conversation state lives: a SQLite file, or in-process memory (tests). */
export type StorageChoice = { kind: "sqlite"; path: string } | { kind: "memory" };

/** Model endpoint descriptor; secrets are injected separately via `models`. */
export interface ModelConfig {
	provider: string;
	modelId: string;
	baseUrl: string;
	/** Anthropic-compatible context window and output cap for the model entry. */
	contextWindow: number;
	maxTokens: number;
	reasoning?: boolean;
	/** Environment variable that holds the API key. The value stays out of this file. */
	keyEnv?: string;
}

export interface SubstrateConfig {
	storage: StorageChoice;
	/** Pre-built pi-ai Models (daemon: CPA/Keychain; tests: fauxProvider). */
	models: Models;
	model: ModelConfig;
	/** Working directory for the agent (AGENT_HOME). */
	agentHome: string;
	/** Extra extensions to install beyond the read-only base (M4/M5/M6 in later phases). */
	extraExtensions?: Extension[];
	/** System instructions for the root conversation. */
	instructions: string;
	/** P1 routing: the owner's chat/open_id migrate into the binding table's first row. */
	homeChatId?: string;
	ownerOpenId?: string;
}

// ---------------------------------------------------------------------------
// P1 additions: bindings, atomic admission, approvals, control ops
// ---------------------------------------------------------------------------

export type { ChannelBinding, ChannelPolicy, ApprovalState } from "./durable-ext/docs.ts";
import {
	ApprovalDoc,
	BindingsDoc,
	DeliveryDoc,
	PendingApprovalsDoc,
	PendingDeliveriesDoc,
	RoutineSessionsDoc,
	SessionApprovalsDoc,
	sessionApprovalKey,
	type ApprovalState,
	type ChannelBinding,
	type DeliveryState,
} from "./durable-ext/docs.ts";

export type AdmitResult =
	| { kind: "admitted"; submissionId: SubmissionId }
	| { kind: "denied"; reason: string }
	| { kind: "unbound" };

/** Pure admission policy (P1-1.2); exported for the T-P1-1a matrix test. */
export function checkPolicy(
	binding: ChannelBinding,
	msg: { senderId: string; isBot: boolean; isMention: boolean },
): string | null {
	const { policy } = binding;
	if (policy.dropBots && msg.isBot) return "bot-dropped";
	if (policy.groupPolicy === "disabled") return "group-disabled";
	// INV-P1-1: nothing outside allowSenders is ever submitted (DM, group, commands alike).
	if (!policy.allowSenders.includes(msg.senderId)) return "sender-not-allowed";
	if (policy.mentionOnly && !msg.isMention) return "mention-required";
	if (policy.muted.includes(msg.senderId)) return "muted";
	return null;
}

/**
 * Backfill watermark per chat, in epoch milliseconds of Lark server time
 * (P0-3.4: milliseconds stored; both channels use the same server clock).
 */
export const WatermarkDoc = defineDocFamily<{ watermarkMs: number; chatId: string }, string>({
	kind: "pots.watermark",
	version: 1,
	scope: "session",
	family: true,
	initial: (chatId) => ({ watermarkMs: 0, chatId }),
	checkpointWhen: () => false,
});

const PROGRESS_INTERVAL_MS = 200; // F17: leaves headroom under the card 10 QPS cap

/** Join the text blocks of an assistant message (thinking/blocks ignored); defensive to schema drift. */
function assistantText(message: unknown): string {
	if (message === null || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block !== null &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("");
}

/** Same extraction for `pi.live.generation.message` (the streamed partial). */
export function partialText(liveDoc: unknown): string {
	if (liveDoc === null || typeof liveDoc !== "object") return "";
	const generation = (liveDoc as { generation?: unknown }).generation;
	if (generation === null || typeof generation !== "object") return "";
	return assistantText((generation as { message?: unknown }).message);
}

/** The seam the rest of the daemon sees. Nothing pi-durable leaks past this module. */
export interface Substrate {
	resume(): void;
	/** The conversation bound to a chat; created on first use (P0: always the root conversation). */
	conversationFor(chatId: string): Promise<Conversation>;
	/** The reserved root conversation. */
	root(): Promise<Conversation>;
	/** Admit input; `requestId` idempotency: same id returns the same submission (INV-P0-2). */
	submit(conv: Conversation, draft: SubmissionDraft, context?: Context): Promise<Submission>;
	/**
	 * Atomic admission (F10 order): `conv.submit(tx, draft)` is the commit's FIRST table write,
	 * then the watermark doc write joins the same commit. P1 admission policy extends this
	 * callback (policy checks before, binding writes after, per P1-1.2).
	 */
	admit(
		conv: Conversation,
		draft: SubmissionDraft,
		watermark: { chatId: string; ms: number } | undefined,
	): Promise<SubmissionId>;
	/** Text of a committed assistant entry (the final answer of a run). */
	answerText(entryId: EntryId): Promise<string>;
	/** Reacquire a submission after a restart, as a seam-level handle. */
	submission(id: SubmissionId): Promise<SubmissionHandle | undefined>;
	/**
	 * One atomic commit on the harness line. ReadAfterWrite rule (F10): if the callback admits via
	 * `conv.submit(tx, draft)`, that admission must be the commit's FIRST table write — before
	 * `appendEntry`/`createTask`/another admission — or it throws. Document reads/writes are exempt.
	 */
	commit<T>(change: (tx: Tx) => T | Promise<T>, context?: Context): Promise<T>;
	/** Structural watch of a conversation; resolves to a stop function. */
	watch(conv: Conversation, listener: (view: ConversationView) => void, context?: Context): Promise<() => void>;
	/** Read one watermark; absent chats return undefined. */
	watermark(chatId: string): Promise<number | undefined>;
	/** Persist the watermark in its own commit. */
	setWatermark(chatId: string, watermarkMs: number): Promise<void>;
	/** Reacquire a submission after a restart (raw handle; prefer the typed `submission`). */
	submissionById(id: SubmissionId): Promise<Submission | undefined>;
	/** Cleanly close; pending work stays durable and resumes on the next open. */
	close(): Promise<void>;
	/** Settles after close(), or after a storage failure closes the harness. */
	readonly closed: Promise<SessionEnd>;
	/** Diagnostic dump for `pots status` and tests. */
	inspect(): Promise<{ conversations: string[]; usage: Record<string, unknown> }>;
	// ----- P1: routing table -----
	/** The routing table and its home chat (P0 migration lands homeChatId as row one). */
	bindings(): Promise<{ bindings: Record<string, ChannelBinding>; homeChatId: string }>;
	/** Create or replace a binding in one commit (channel_bind tool / DM natural language). */
	bindChannel(input: { chatId: string; cwd: string; boardPath?: string; isGroup: boolean }): Promise<string>;
	/** Resolve the conversation bound to a chat root. */
	bindingConversation(chatId: string): Promise<Conversation>;
	/** Resolve the conversation for a chat root or one Feishu thread. */
	sessionConversation(chatId: string, threadId?: string): Promise<Conversation>;
	/** Atomic admission (P1-1.2): policy + binding read + submit + watermark in ONE commit. */
	admitBinding(
		chatId: string,
		msg: { messageId: string; text: string; senderId: string; isBot: boolean; isMention: boolean; sentAt: number; threadId?: string },
	): Promise<AdmitResult>;
	/** Reverse lookup: which chat owns a conversation (approval cards route back). */
	chatOfConversation(conversationId: number): Promise<string | undefined>;
	// ----- P1: remote control (owner-only; callers check owner after policy) -----
	abortConversation(chatId: string): Promise<void>;
	resetConversation(chatId: string, note: string): Promise<void>;
	compactConversation(chatId: string): Promise<void>;
	statusText(chatId: string): Promise<string>;
	// ----- P1: M5 approval doc operations (manager lives app-side; R2-1) -----
	getApproval(approvalId: string): Promise<ApprovalState | undefined>;
	/** Create the pending doc idempotently; false when it already exists (crash re-entry). */
	createApprovalPending(state: ApprovalState & { approvalId: string }): Promise<boolean>;
	/** Verdict with the pending-guard: only a pending approval is written (R2-3). */
	decideApproval(approvalId: string, status: ApprovalState["status"], decidedBy: string): Promise<boolean>;
	/** A spent approval (once, session, deny, timeout) becomes pending again. */
	reopenApproval(approvalId: string, deadlineAt: number): Promise<boolean>;
	/** All pending approval ids with their deadlines (janitor + startup sweep). */
	pendingApprovals(): Promise<Array<{ approvalId: string; deadlineAt: number; chatId: string }>>;
	/** Record an "Always" session approval (4h TTL, exact digest; F21). */
	setSessionApproval(conversationId: number, toolName: string, digest: string, approvalId: string): Promise<void>;
	/** Outbox. The first writer owns the request; a repeat returns false. */
	recordDelivery(state: DeliveryState): Promise<boolean>;
	deliveryOf(requestId: string): Promise<DeliveryState | undefined>;
	markDeliverySent(requestId: string): Promise<void>;
	pendingDeliveries(): Promise<DeliveryState[]>;
	/** A conversation used only by one routine. cwd and chatId are remembered for tools and approval cards. */
	routineConversation(routineId: string, place?: { cwd?: string; chatId?: string }): Promise<Conversation>;
	// ----- P1: M4 patrol task lifecycle -----
	/** Create a singleton task owned by the root conversation if none live. */
	ensureRootTask(task: TaskLike): Promise<boolean>;
	/** Create the patrol task for a chat if none is live; true when created. */
	ensurePatrol(
		chatId: string,
		taskFactory: () => { task: TaskLike; input: { chatId: string } },
	): Promise<boolean>;
}

/** Minimal structural type for a task definition handed in by the daemon. */
export interface TaskLike {
	definition: { name: string; version: number };
}

/** Build the CPA provider: an anthropic-compatible endpoint whose key arrives via `apiKeyFor`. */
export function buildCpaProvider(cfg: ModelConfig, apiKeyFor: () => Promise<string | undefined>): Provider {
	return createProvider({
		id: cfg.provider,
		baseUrl: cfg.baseUrl,
		auth: {
			apiKey: {
				name: `${cfg.provider} API key`,
				resolve: async () => {
					const apiKey = await apiKeyFor();
					if (apiKey === undefined) return undefined;
					return { auth: { apiKey }, source: "Keychain" };
				},
			},
		},
		models: [
			{
				id: cfg.modelId,
				name: cfg.modelId,
				api: "anthropic-messages",
				provider: cfg.provider,
				baseUrl: cfg.baseUrl,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // CPA routes by plan
				reasoning: cfg.reasoning ?? false,
				contextWindow: cfg.contextWindow,
				maxTokens: cfg.maxTokens,
			},
		],
		api: { "anthropic-messages": anthropicMessagesApi() },
	});
}

/** Convenience for the daemon: Models with the single CPA provider pre-registered. */
export function buildModels(cfg: ModelConfig, apiKeyFor: () => Promise<string | undefined>): Models {
	const models = createModels();
	models.setProvider(buildCpaProvider(cfg, apiKeyFor));
	return models;
}

export async function openSubstrate(cfg: SubstrateConfig): Promise<Substrate> {
	const storage: Storage =
		cfg.storage.kind === "memory" ? new MemoryStorage() : await openNodeSqliteStorage(cfg.storage.path);

	// P0 registry: read-only. `read` is an independent tool factory — nothing installs
	// write/edit/bash automatically, so not installing them IS the security posture (F05).
	const registry = createRegistry();
	registry.install(defineExtension({ name: "pots-readonly", tools: [createReadTool()] }));
	for (const ext of cfg.extraExtensions ?? []) registry.install(ext);

	const agentHome = cfg.agentHome;
	const harness = await Harness.open(storage, {
		models: cfg.models,
		registry,
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? agentHome }),
		settings: {
			retry: { maxRetries: 3 },
			progress: { partialIntervalMs: PROGRESS_INTERVAL_MS, persistWithinMs: 1000 },
			toolExecution: "parallel",
		},
	}, BACKGROUND_CONTEXT);

	let rootPromise: Promise<Conversation> | undefined;

	const rootConversation = () =>
		(rootPromise ??= harness.root(BACKGROUND_CONTEXT, {
			agent: {
				model: { provider: cfg.model.provider, modelId: cfg.model.modelId },
				cwd: agentHome,
				instructions: cfg.instructions,
			},
		}));

	const modelRef = { provider: cfg.model.provider, modelId: cfg.model.modelId };

	/** Trusted cast: binding docs store conversation ids as plain JSON numbers. */
	const convId = (n: number) => n as ConversationId;

	const bindingsSnapshot = async () => await harness.snapshot(BindingsDoc, BACKGROUND_CONTEXT);

	async function bindingConversation(chatId: string): Promise<Conversation> {
		const table = await bindingsSnapshot();
		const binding = table?.bindings[chatId];
		if (binding !== undefined) {
			const conv = await harness.conversation(convId(binding.conversationId), BACKGROUND_CONTEXT);
			if (conv !== undefined) return conv;
			// Corrupt binding (conversation vanished): degrade to root rather than fail.
		}
		return rootConversation();
	}

	/** Channel root uses the binding conversation. Each Feishu thread gets its own conversation. */
	async function sessionConversation(chatId: string, threadId?: string): Promise<Conversation> {
		if (!threadId) return bindingConversation(chatId);
		const table = await bindingsSnapshot();
		const known = table?.bindings[chatId]?.threads?.[threadId];
		if (known !== undefined) {
			const existing = await harness.conversation(convId(known), BACKGROUND_CONTEXT);
			if (existing !== undefined) return existing;
		}
		const created = await harness.commit(async (tx) => {
			const doc = await tx.doc(BindingsDoc);
			const binding = doc.bindings[chatId];
			if (binding === undefined) return undefined;
			const threads = { ...(binding.threads ?? {}) };
			if (threads[threadId] !== undefined) return threads[threadId];
			const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await configure(tx, record.id, { model: modelRef, cwd: binding.cwd });
			threads[threadId] = Number(record.id);
			doc.bindings[chatId] = { ...binding, threads };
			return Number(record.id);
		}, BACKGROUND_CONTEXT);
		if (created === undefined) return rootConversation();
		return (await harness.conversation(convId(created), BACKGROUND_CONTEXT)) ?? rootConversation();
	}

	/** P0→P1 migration: homeChatId becomes the table's first row, bound to the ROOT conversation. */
	async function migrateHomeBinding(): Promise<void> {
		if (!cfg.homeChatId || !cfg.ownerOpenId) return;
		const table = await bindingsSnapshot();
		if (table?.bindings[cfg.homeChatId] !== undefined) return;
		const root = await rootConversation();
		await harness.commit(async (tx) => {
			const doc = await tx.doc(BindingsDoc);
			if (doc.bindings[cfg.homeChatId as string] !== undefined) return; // re-check in commit
			doc.bindings[cfg.homeChatId as string] = {
				chatId: cfg.homeChatId as string,
				conversationId: Number(root.id),
				cwd: agentHome,
				policy: {
					allowSenders: [cfg.ownerOpenId as string],
					groupPolicy: "open",
					mentionOnly: false,
					muted: [],
					dropBots: true,
					whenBusy: "followUp",
				},
				createdAt: Date.now(),
			};
			doc.homeChatId = cfg.homeChatId as string;
		}, BACKGROUND_CONTEXT);
	}
	await migrateHomeBinding();

	/** Internal signal: binding changed between the pre-read and the commit; retry once. */
	class BindingChanged extends Error {}

	const SESSION_APPROVAL_TTL_MS = 4 * 60 * 60 * 1000; // F21

	return {
		resume: () => harness.resume(),
		root: rootConversation,
		conversationFor: (chatId: string) => bindingConversation(chatId),
		submit: (conv, draft, context = BACKGROUND_CONTEXT) => conv.submit(draft, context),
		admit: (conv, draft, watermark) =>
			harness.commit(async (tx) => {
				// F10: admission must precede every other table write in this commit.
				const id = await conv.submit(tx, draft);
				if (watermark) {
					const doc = await tx.doc(WatermarkDoc, watermark.chatId, watermark.chatId);
					doc.watermarkMs = watermark.ms;
				}
				return id;
			}, BACKGROUND_CONTEXT),
		answerText: async (entryId) => {
			const entry = await harness.commit(
				(tx) => tx.entry(AssistantEntry, entryId),
				BACKGROUND_CONTEXT,
			);
			return assistantText(entry?.model?.[0]);
		},
		submission: async (id) => {
			const raw = await harness.submission(id, BACKGROUND_CONTEXT);
			if (raw === undefined) return undefined;
			return {
				wait: async () => {
					const settled = await raw.wait(BACKGROUND_CONTEXT);
					if (settled.status === "done") {
						return settled.type === "input"
							? { status: "done", answer: settled.answer }
							: { status: "done" };
					}
					return { status: "unanswered", reason: settled.reason };
				},
			};
		},
		commit: (change, context = BACKGROUND_CONTEXT) => harness.commit(change, context),
		watch: async (conv, listener, context = BACKGROUND_CONTEXT) => {
			const handle = await conv.watch(context);
			await handle.start(async (call) => {
				if (call.kind === "value") listener(call.value);
			});
			return () => {
				void handle.stop();
			};
		},
		watermark: async (chatId) =>
			(await harness.snapshot(WatermarkDoc, chatId, BACKGROUND_CONTEXT))?.watermarkMs,
		setWatermark: (chatId, watermarkMs) =>
			harness.commit(async (tx) => {
				const doc = await tx.doc(WatermarkDoc, chatId, chatId);
				doc.watermarkMs = watermarkMs;
			}, BACKGROUND_CONTEXT),
		submissionById: (id) => harness.submission(id, BACKGROUND_CONTEXT),
		close: () => harness.close(BACKGROUND_CONTEXT),
		get closed() {
			return harness.closed;
		},
		inspect: async () => {
			const usage = await harness.usage(BACKGROUND_CONTEXT);
			const page = await harness.commit((tx) => tx.scanConversations({}, 100), BACKGROUND_CONTEXT);
			return {
				conversations: page.items.map((c) => String(c.id)),
				usage: usage as unknown as Record<string, unknown>,
			};
		},
		// ----- P1: routing table -----
		bindings: async () => {
			const table = await bindingsSnapshot();
			return { bindings: table?.bindings ?? {}, homeChatId: table?.homeChatId ?? "" };
		},
		bindChannel: async ({ chatId, cwd, boardPath, isGroup }) =>
			harness.commit(async (tx) => {
				const doc = await tx.doc(BindingsDoc);
				const existing = doc.bindings[chatId];
				let conversationId: number;
				if (existing === undefined) {
					const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
					await configure(tx, record.id, { model: modelRef, cwd });
					conversationId = Number(record.id);
				} else {
					conversationId = existing.conversationId;
					if (existing.cwd !== cwd) {
						await configure(tx, convId(conversationId), { cwd });
					}
				}
				const next: ChannelBinding = {
					chatId,
					conversationId,
					cwd,
					boardPath,
					policy:
						existing?.policy ??
						{
							allowSenders: cfg.ownerOpenId ? [cfg.ownerOpenId] : [],
							groupPolicy: "open" as const,
							mentionOnly: isGroup,
							muted: [],
							dropBots: true,
							whenBusy: "followUp" as const,
						},
					createdAt: existing?.createdAt ?? Date.now(),
				};
				doc.bindings[chatId] = boardPath === undefined
					? (({ boardPath: _drop, ...rest }) => rest)(next) // docs are JSON: no undefined values
					: next;
				return `bound ${chatId} → conversation ${conversationId} (cwd ${cwd}${boardPath ? `, board ${boardPath}` : ""})`;
			}, BACKGROUND_CONTEXT),
		bindingConversation: (chatId: string) => bindingConversation(chatId),
		sessionConversation: (chatId: string, threadId?: string) => sessionConversation(chatId, threadId),
		admitBinding: (async (chatId: string, msg: { messageId: string; text: string; senderId: string; isBot: boolean; isMention: boolean; sentAt: number; threadId?: string }) => {
			for (let attempt = 0; attempt < 2; attempt++) {
				const conv = await sessionConversation(chatId, msg.threadId);
				try {
					return await harness.commit(async (tx) => {
						const doc = await tx.doc(BindingsDoc);
						const binding = doc.bindings[chatId];
						if (binding === undefined) return { kind: "unbound" } as AdmitResult;
						const denial = checkPolicy(binding, msg);
						if (denial !== null) return { kind: "denied", reason: denial } as AdmitResult;
						const expected = msg.threadId ? binding.threads?.[msg.threadId] : binding.conversationId;
						if (expected !== Number(conv.id)) throw new BindingChanged();
						const submissionId = await conv.submit(tx, {
							type: "input",
							content: msg.text,
							requestId: `feishu:${msg.messageId}`,
							whenBusy: binding.policy.whenBusy,
						});
						const wm = await tx.doc(WatermarkDoc, chatId, chatId);
						wm.watermarkMs = msg.sentAt;
						return { kind: "admitted", submissionId } as AdmitResult;
					}, BACKGROUND_CONTEXT);
				} catch (error) {
					if (error instanceof BindingChanged && attempt === 0) continue;
					throw error;
				}
			}
			throw new Error("admitBinding: binding kept changing");
		}) as Substrate["admitBinding"],
		chatOfConversation: async (conversationId) => {
			const table = await bindingsSnapshot();
			for (const binding of Object.values(table?.bindings ?? {})) {
				if (binding.conversationId === conversationId) return binding.chatId;
				for (const threadConversation of Object.values(binding.threads ?? {})) {
					if (threadConversation === conversationId) return binding.chatId;
				}
			}
			const routines = await harness.snapshot(RoutineSessionsDoc, BACKGROUND_CONTEXT);
			for (const session of Object.values(routines?.sessions ?? {})) {
				if (session.conversationId === conversationId && session.chatId) return session.chatId;
			}
			return undefined;
		},
		// ----- P1: remote control -----
		abortConversation: async (chatId) => {
			const conv = await bindingConversation(chatId);
			await conv.abort(BACKGROUND_CONTEXT);
		},
		resetConversation: async (chatId, note) => {
			const conv = await bindingConversation(chatId);
			await conv.reset(note, BACKGROUND_CONTEXT);
		},
		compactConversation: async (chatId) => {
			const conv = await bindingConversation(chatId);
			await conv.compact(undefined, BACKGROUND_CONTEXT);
		},
		statusText: async (chatId) => {
			const conv = await bindingConversation(chatId);
			const live = await harness.snapshot(LiveDoc, conv.id, BACKGROUND_CONTEXT);
			const inbox = await harness.snapshot(InboxDoc, conv.id, BACKGROUND_CONTEXT);
			const queued = Array.isArray(inbox?.items) ? inbox.items.length : 0;
			const lines = [`conversation ${conv.id} · chat ${chatId}`];
			if (live?.run) {
				lines.push(`run 进行中（turn ${live.run.turns}，in-flight 工具 ${live.tools?.length ?? 0}）`);
			} else if (live?.runFailure) {
				lines.push(`上次 run 未获回答：${live.runFailure.reason}`);
			} else {
				lines.push("run 空闲");
			}
			lines.push(`inbox 排队：${queued}`);
			return lines.join("\n");
		},
		// ----- P1: M5 approval doc operations -----
		getApproval: async (approvalId) =>
			await harness.snapshot(ApprovalDoc, approvalId, BACKGROUND_CONTEXT),
		createApprovalPending: async (state) => {
			const before = await harness.snapshot(ApprovalDoc, state.approvalId, BACKGROUND_CONTEXT);
			if (before !== undefined) return false;
			await harness.commit(async (tx) => {
				const doc = await tx.doc(ApprovalDoc, state.approvalId, state.approvalId);
				doc.toolName = state.toolName;
				doc.digest = state.digest;
				doc.argsPreview = state.argsPreview;
				doc.conversationId = state.conversationId;
				doc.chatId = state.chatId;
				doc.status = "pending";
				doc.createdAt = state.createdAt;
				doc.deadlineAt = state.deadlineAt;
				const index = await tx.doc(PendingApprovalsDoc);
				if (!index.approvalIds.includes(state.approvalId)) {
					index.approvalIds = [...index.approvalIds, state.approvalId];
				}
			}, BACKGROUND_CONTEXT);
			return true;
		},
		decideApproval: (approvalId, status, decidedBy) =>
			harness.commit(async (tx) => {
				const doc = await tx.doc(ApprovalDoc, approvalId, approvalId);
				// R2-3 pending-guard: first writer wins; a late verdict cannot revive a timeout.
				if (doc.status !== "pending") return false;
				doc.status = status;
				doc.decidedAt = Date.now();
				doc.decidedBy = decidedBy;
				const index = await tx.doc(PendingApprovalsDoc);
				index.approvalIds = index.approvalIds.filter((id) => id !== approvalId);
				return true;
			}, BACKGROUND_CONTEXT),
		reopenApproval: (approvalId, deadlineAt) =>
			harness.commit(async (tx) => {
				const doc = await tx.doc(ApprovalDoc, approvalId, approvalId);
				if (doc.status === "pending" || doc.digest === "") return false;
				doc.status = "pending";
				doc.deadlineAt = deadlineAt;
				delete doc.decidedAt;
				delete doc.decidedBy;
				const index = await tx.doc(PendingApprovalsDoc);
				if (!index.approvalIds.includes(approvalId)) {
					index.approvalIds = [...index.approvalIds, approvalId];
				}
				return true;
			}, BACKGROUND_CONTEXT),
		pendingApprovals: async () => {
			const index = await harness.snapshot(PendingApprovalsDoc, BACKGROUND_CONTEXT);
			const out: Array<{ approvalId: string; deadlineAt: number; chatId: string }> = [];
			for (const approvalId of index?.approvalIds ?? []) {
				const doc = await harness.snapshot(ApprovalDoc, approvalId, BACKGROUND_CONTEXT);
				if (doc?.status === "pending") {
					out.push({ approvalId, deadlineAt: doc.deadlineAt, chatId: doc.chatId });
				}
			}
			return out;
		},
		setSessionApproval: (conversationId, toolName, digest, approvalId) =>
			harness.commit(async (tx) => {
				const key = sessionApprovalKey(conversationId, toolName, digest);
				const doc = await tx.doc(SessionApprovalsDoc, key, key);
				doc.expiresAt = Date.now() + SESSION_APPROVAL_TTL_MS;
				doc.approvalId = approvalId;
			}, BACKGROUND_CONTEXT),
		recordDelivery: (state) =>
			harness.commit(async (tx) => {
				const doc = await tx.doc(DeliveryDoc, state.requestId, state.requestId);
				if (doc.updatedAt > 0) return false;
				doc.requestId = state.requestId;
				doc.submissionId = state.submissionId;
				doc.chatId = state.chatId;
				doc.threadId = state.threadId;
				doc.status = "pending";
				doc.updatedAt = Date.now();
				const index = await tx.doc(PendingDeliveriesDoc);
				if (!index.requestIds.includes(state.requestId)) {
					index.requestIds = [...index.requestIds, state.requestId];
				}
				return true;
			}, BACKGROUND_CONTEXT),
		deliveryOf: async (requestId) => {
			const doc = await harness.snapshot(DeliveryDoc, requestId, BACKGROUND_CONTEXT);
			if (doc === undefined || doc.updatedAt === 0) return undefined;
			return doc;
		},
		markDeliverySent: (requestId) =>
			harness.commit(async (tx) => {
				const doc = await tx.doc(DeliveryDoc, requestId, requestId);
				if (doc.updatedAt === 0) return;
				doc.status = "sent";
				doc.updatedAt = Date.now();
				const index = await tx.doc(PendingDeliveriesDoc);
				index.requestIds = index.requestIds.filter((id) => id !== requestId);
			}, BACKGROUND_CONTEXT),
		pendingDeliveries: async () => {
			const index = await harness.snapshot(PendingDeliveriesDoc, BACKGROUND_CONTEXT);
			const out: DeliveryState[] = [];
			for (const requestId of index?.requestIds ?? []) {
				const doc = await harness.snapshot(DeliveryDoc, requestId, BACKGROUND_CONTEXT);
				if (doc !== undefined && doc.status === "pending" && doc.updatedAt > 0) out.push(doc);
			}
			return out;
		},
		routineConversation: async (routineId, place) => {
			const cwd = place?.cwd || agentHome;
			const chatId = place?.chatId || "";
			const existing = await harness.snapshot(RoutineSessionsDoc, BACKGROUND_CONTEXT);
			const known = existing?.sessions[routineId];
			if (known !== undefined) {
				const conv = await harness.conversation(convId(known.conversationId), BACKGROUND_CONTEXT);
				if (conv !== undefined) return conv;
			}
			const created = await harness.commit(async (tx) => {
				const doc = await tx.doc(RoutineSessionsDoc);
				const current = doc.sessions[routineId];
				if (current !== undefined) return current.conversationId;
				const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
				await configure(tx, record.id, { model: modelRef, cwd });
				doc.sessions = { ...doc.sessions, [routineId]: { conversationId: Number(record.id), cwd, chatId } };
				return Number(record.id);
			}, BACKGROUND_CONTEXT);
			return (await harness.conversation(convId(created), BACKGROUND_CONTEXT)) ?? rootConversation();
		},
		ensureRootTask: async (task) => {
			const root = await rootConversation();
			const page = await harness.commit(
				(tx) => tx.scanTasks({ kind: task.definition.name, conversationId: root.id }, 1),
				BACKGROUND_CONTEXT,
			);
			const live = page.items.find((t) => t.state.status !== "terminal");
			if (live !== undefined) return false;
			await harness.commit(async (tx) => {
				await tx.createTask(task as never, {}, {
					ownership: { kind: "conversation" },
					conversationId: root.id,
					background: true,
				});
			}, BACKGROUND_CONTEXT);
			return true;
		},
		// ----- P1: M4 patrol lifecycle -----
		ensurePatrol: async (chatId, taskFactory) => {
			const table = await bindingsSnapshot();
			const binding = table?.bindings[chatId];
			if (binding === undefined || binding.boardPath === undefined) return false;
			const page = await harness.commit(
				(tx) => tx.scanTasks({ kind: taskFactory().task.definition.name, conversationId: convId(binding.conversationId) }, 1),
				BACKGROUND_CONTEXT,
			);
			const live = page.items.find((t) => t.state.status !== "terminal");
			if (live !== undefined) return false;
			const { task, input } = taskFactory();
			await harness.commit(async (tx) => {
				await tx.createTask(task as never, input, {
					ownership: { kind: "conversation" },
					conversationId: convId(binding.conversationId),
					background: true, // survives conversation aborts and idle waits
				});
			}, BACKGROUND_CONTEXT);
			return true;
		},
	};
}
