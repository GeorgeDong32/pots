import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSubstrate, type ModelConfig, type Substrate } from "../src/substrate.ts";

/** A faux-backed substrate over in-memory storage. */
export async function openTestSubstrate(
	faux = fauxProvider(),
	extra?: { storage?: "memory" | "sqlite"; dir?: string },
): Promise<{ substrate: Substrate; faux: ReturnType<typeof fauxProvider> }> {
	const model = faux.getModel();
	const cfgModel: ModelConfig = {
		provider: model.provider,
		modelId: model.id,
		baseUrl: "http://faux.test",
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
	const { createModels } = await import("@earendil-works/pi-ai");
	const models = createModels();
	models.setProvider(faux.provider);
	const substrate = await openSubstrate({
		storage:
			extra?.storage === "sqlite"
				? { kind: "sqlite", path: join(extra.dir ?? tmpdir(), `t-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`) }
				: { kind: "memory" },
		models,
		model: cfgModel,
		agentHome: process.cwd(),
		instructions: "test agent",
	});
	return { substrate, faux };
}

export function oneShot(answer: string): void {
	// convenience wrapper for a single scripted response
	void answer;
}

export function textAnswer(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(text);
}

export function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pots-test-"));
}

export function cleanupDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}
