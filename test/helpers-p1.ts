import { fauxProvider } from "@earendil-works/pi-ai";
import { openSubstrate, type Extension, type Substrate } from "../src/substrate.ts";

/** P1 test helper: substrate with routing init and optional extra extensions. */
export async function openTestSubstrate(
	options: {
		homeChatId?: string;
		ownerOpenId?: string;
		extraExtensions?: Extension[];
		faux?: ReturnType<typeof fauxProvider>;
	} = {},
): Promise<{ substrate: Substrate; faux: ReturnType<typeof fauxProvider> }> {
	const faux = options.faux ?? fauxProvider();
	const { createModels } = await import("@earendil-works/pi-ai");
	const model = faux.getModel();
	const models = createModels();
	models.setProvider(faux.provider);
	const substrate = await openSubstrate({
		storage: { kind: "memory" },
		models,
		model: {
			provider: model.provider,
			modelId: model.id,
			baseUrl: "http://faux.test",
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		},
		agentHome: process.cwd(),
		instructions: "test agent",
		homeChatId: options.homeChatId,
		ownerOpenId: options.ownerOpenId,
		extraExtensions: options.extraExtensions,
	});
	return { substrate, faux };
}

export { checkPolicy } from "../src/substrate.ts";
