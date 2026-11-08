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
	MemoryStorage,
	createRegistry,
	defineDocFamily,
	defineExtension,
	type Conversation,
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
}

/**
 * Backfill watermark per chat, in epoch milliseconds of Lark server time
 * (P0-3.4: milliseconds stored; both channels use the same server clock).
 */
export const WatermarkDoc = defineDocFamily<{ watermarkMs: number; chatId: string }, string>({
	kind: "pi-larkd.watermark",
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
	/** Diagnostic dump for `pi-larkd status` and tests. */
	inspect(): Promise<{ conversations: string[]; usage: Record<string, unknown> }>;
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
	registry.install(defineExtension({ name: "pi-larkd-readonly", tools: [createReadTool()] }));
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

	return {
		resume: () => harness.resume(),
		root: rootConversation,
		conversationFor: async () => rootConversation(), // P0: single conversation
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
	};
}
