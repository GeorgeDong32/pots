/**
 * pi-larkd daemon entry — assembles M1/M2/M3, holds the single-instance lock,
 * and shuts down gracefully on SIGTERM (F06/F12/F13/F15).
 */
import { openSync, closeSync, unlinkSync, writeSync, existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createChannel } from "./channel.js";
import type { LarkdConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { readKeychainSecret } from "./keychain.js";
import { createLogger, type Logger } from "./log.js";
import { createBridge } from "./bridge.js";
import { buildModels, openSubstrate, type Substrate } from "./substrate.js";

const SHUTDOWN_NOTE = "⏸ pi-larkd 正在关闭（重启后会继续未完成的回复）。";

interface ProcessLock {
	release(): void;
}

/**
 * Single-instance mutex (F12). macOS ships no flock(1); the O_EXCL pidfile with
 * liveness probing gives the same guarantee for a manually-started second copy
 * racing the launchd job (recorded in DEVIATIONS.md).
 */
function acquireProcessLock(path: string): ProcessLock {
	if (existsSync(path)) {
		try {
			const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
			if (Number.isInteger(pid)) {
				process.kill(pid, 0); // throws ESRCH when stale
				console.error(`pi-larkd: another instance is running (pid ${pid}); exiting`);
				process.exit(1);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
				console.error(`pi-larkd: cannot probe existing lock ${path}: ${(error as Error).message}`);
				process.exit(1);
			}
			unlinkSync(path); // stale lock
		}
	}
	const fd = openSync(path, "wx");
	writeSync(fd, `${process.pid}\n`);
	closeSync(fd);
	return {
		release() {
			try {
				unlinkSync(path);
			} catch {
				// Best effort on shutdown.
			}
		},
	};
}

async function main(): Promise<void> {
	const configPath = process.env.PI_LARKD_CONFIG;
	if (!configPath) {
		console.error("pi-larkd: PI_LARKD_CONFIG (path to config.json) is required");
		process.exit(2);
	}
	const cfg: LarkdConfig = loadConfig(configPath);
	mkdirSync(cfg.agentHome, { recursive: true });
	const logger = createLogger("info");

	const lock = acquireProcessLock(join(cfg.agentHome, "daemon.lock"));

	// F13: secrets come from the Keychain, never from the config file or plist.
	const [larkAppSecret, modelApiKey] = await Promise.all([
		readKeychainSecret(cfg.keychain.service, cfg.keychain.larkSecretAccount),
		readKeychainSecret(cfg.keychain.service, cfg.keychain.modelKeyAccount),
	]);

	const substrate: Substrate = await openSubstrate({
		storage: { kind: "sqlite", path: cfg.dbPath },
		models: buildModels(cfg.model, async () => modelApiKey),
		model: cfg.model,
		agentHome: cfg.agentHome,
		instructions:
			`你是 GD 的个人 agent（pi-larkd），经飞书与 owner 双工对话。` +
			`当前为只读模式：你可以读取文件回答问题，但没有任何写入或执行工具。` +
			`回答简洁、直接、使用中文；涉及路径与命令时给出准确信息。`,
	});
	substrate.resume(); // continue runs the last process left unfinished (A2)

	const channel = createChannel({
		appId: envOrThrow("LARK_APP_ID", logger),
		appSecret: larkAppSecret,
		botName: cfg.botName,
		larkCliPath: cfg.larkCliPath,
		logger,
	});
	const bridge = createBridge({ substrate, channel, config: cfg, logger });

	let shuttingDown = false;
	async function shutdown(signal: string): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("shutting down", { signal });
		try {
			// F15 order: stop admitting (shuttingDown flag) → finalize cards → close WS → close harness → exit 0.
			await bridge.finalize(SHUTDOWN_NOTE);
			await channel.stop();
			await substrate.close();
		} catch (error) {
			logger.error("shutdown error", { error: (error as Error).message });
		} finally {
			lock.release();
			process.exit(0);
		}
	}
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
	// A storage failure closes the harness by itself; exit non-zero so launchd
	// KeepAlive={Crashed:true} restarts us (F07).
	void substrate.closed.then((end) => {
		if (!shuttingDown) {
			logger.error("harness closed underneath the daemon", { kind: end.kind });
			lock.release();
			process.exit(1);
		}
	});

	await channel.start();
	logger.info("pi-larkd started", {
		homeChatId: cfg.homeChatId,
		dbPath: cfg.dbPath,
		pid: process.pid,
	});

	// The daemon never exits on its own: a degraded-but-alive posture beats a
	// restart loop (F07). Unhandled rejections are logged, not fatal.
	process.on("unhandledRejection", (reason) => {
		logger.error("unhandled rejection", { error: String(reason) });
	});
}

function envOrThrow(name: string, logger: Logger): string {
	const value = process.env[name];
	if (!value) {
		logger.error(`missing required env var ${name}`);
		process.exit(2);
	}
	return value;
}

void main().catch((error) => {
	console.error(`pi-larkd: fatal: ${(error as Error).stack ?? error}`);
	process.exit(1);
});
