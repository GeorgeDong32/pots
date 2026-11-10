import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelConfig } from "./substrate.ts";

/**
 * Daemon configuration. Secrets stay in ~/.pots/.env (Hermes style) or, if
 * those variables are absent, in the macOS Keychain.
 */
export interface PotsConfig {
	/** The single bound chat for P0; all other chats are denied with a notice (F23). */
	homeChatId: string;
	/** Owner's Lark open_id (used for card-action authorization in P1; carried from P0). */
	ownerOpenId: string;
	/** Bot display name for the Chat SDK. */
	botName: string;
	model: ModelConfig;
	/** SQLite database file. */
	dbPath: string;
	/** Agent working directory (AGENT_HOME). */
	agentHome: string;
	/** Keychain item names (service, account). */
	keychain: {
		service: string;
		larkSecretAccount: string;
		modelKeyAccount: string;
	};
	/** Path to lark-cli binary (backfill channel). */
	larkCliPath: string;
	/** Log file path (launchd StandardOutPath). */
	logPath: string;
}

interface RawConfig {
	homeChatId?: unknown;
	ownerOpenId?: unknown;
	botName?: unknown;
	model?: Record<string, unknown>;
	dbPath?: unknown;
	agentHome?: unknown;
	keychain?: Record<string, unknown>;
	larkCliPath?: unknown;
	logPath?: unknown;
}

function expectString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`config: "${field}" must be a non-empty string`);
	}
	return value;
}

export const DEFAULT_AGENT_HOME = join(homedir(), ".pots");
export const DEFAULT_DB_PATH = join(DEFAULT_AGENT_HOME, "harness.sqlite");
export const DEFAULT_LOG_PATH = join(homedir(), "Library", "Logs", "pots.log");

/** Load and validate the JSON config file. Env fills the same fields Hermes keeps in `.env`. */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): PotsConfig {
	const raw: RawConfig = JSON.parse(readFileSync(path, "utf8"));
	const model = raw.model ?? {};
	const cfg: PotsConfig = {
		homeChatId: expectString(raw.homeChatId ?? env.FEISHU_HOME_CHANNEL, "homeChatId"),
		ownerOpenId: expectString(raw.ownerOpenId ?? firstId(env.FEISHU_ALLOWED_USERS), "ownerOpenId"),
		botName: typeof raw.botName === "string" && raw.botName ? raw.botName : "pots",
		model: {
			provider: expectString(model.provider, "model.provider"),
			modelId: expectString(model.modelId, "model.modelId"),
			baseUrl: expectString(model.baseUrl, "model.baseUrl"),
			contextWindow: Number(model.contextWindow ?? 200_000),
			maxTokens: Number(model.maxTokens ?? 32_768),
			reasoning: model.reasoning === true,
			...(typeof model.keyEnv === "string" && model.keyEnv ? { keyEnv: model.keyEnv } : {}),
		},
		dbPath: typeof raw.dbPath === "string" && raw.dbPath ? raw.dbPath : DEFAULT_DB_PATH,
		agentHome: typeof raw.agentHome === "string" && raw.agentHome ? raw.agentHome : DEFAULT_AGENT_HOME,
		keychain: {
			service:
				typeof raw.keychain?.service === "string" && raw.keychain.service
					? raw.keychain.service
					: "pots",
			larkSecretAccount:
				typeof raw.keychain?.larkSecretAccount === "string" && raw.keychain.larkSecretAccount
					? raw.keychain.larkSecretAccount
					: "lark-app-secret",
			modelKeyAccount:
				typeof raw.keychain?.modelKeyAccount === "string" && raw.keychain.modelKeyAccount
					? raw.keychain.modelKeyAccount
					: "model-api-key",
		},
		larkCliPath: typeof raw.larkCliPath === "string" && raw.larkCliPath ? raw.larkCliPath : "lark-cli",
		logPath: typeof raw.logPath === "string" && raw.logPath ? raw.logPath : DEFAULT_LOG_PATH,
	};
	if (!Number.isFinite(cfg.model.contextWindow) || cfg.model.contextWindow < 1024) {
		throw new Error('config: "model.contextWindow" must be a number >= 1024');
	}
	if (!Number.isFinite(cfg.model.maxTokens) || cfg.model.maxTokens < 1) {
		throw new Error('config: "model.maxTokens" must be a number >= 1');
	}
	if (/oc_[A-Za-z0-9]+/.test(cfg.homeChatId) === false) {
		throw new Error('config: "homeChatId" must be a Lark chat id (oc_...)');
	}
	return cfg;
}

function firstId(value: string | undefined): string | undefined {
	const id = value?.split(/[,\s]+/).find((part) => part.length > 0);
	return id;
}
