import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { loadDotEnv } from "../src/dotenv.ts";

describe("Hermes-style config", () => {
	it("loads .env without replacing variables already set", () => {
		const dir = mkdtempSync(join(tmpdir(), "pots-env-"));
		const file = join(dir, ".env");
		writeFileSync(file, "# comment\nFEISHU_APP_ID=from-file\nPOTS_MODEL_API_KEY=\"quoted\"\nKEEP=no\n");
		const env: NodeJS.ProcessEnv = { KEEP: "yes" };
		loadDotEnv(file, env);
		expect(env.FEISHU_APP_ID).toBe("from-file");
		expect(env.POTS_MODEL_API_KEY).toBe("quoted");
		expect(env.KEEP).toBe("yes");
	});

	it("fills home and owner from FEISHU_* when the json omits them", () => {
		const dir = mkdtempSync(join(tmpdir(), "pots-cfg-"));
		const file = join(dir, "config.json");
		writeFileSync(file, JSON.stringify({
			model: { provider: "cpa", modelId: "demo", baseUrl: "http://127.0.0.1:8317/v1", keyEnv: "POTS_MODEL_API_KEY" },
		}));
		const cfg = loadConfig(file, {
			FEISHU_HOME_CHANNEL: "oc_home",
			FEISHU_ALLOWED_USERS: "ou_owner,ou_other",
		});
		expect(cfg.homeChatId).toBe("oc_home");
		expect(cfg.ownerOpenId).toBe("ou_owner");
		expect(cfg.model.keyEnv).toBe("POTS_MODEL_API_KEY");
	});
});
