import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { cleanupDir, openTestSubstrate, tmpDir } from "./helpers.js";
import { openSubstrate, type ModelConfig, type Substrate } from "../src/substrate.js";

let dir: string | undefined;
const opened: Substrate[] = [];

async function track(s: Substrate): Promise<Substrate> {
	opened.push(s);
	return s;
}

beforeEach(() => {
	dir = tmpDir();
});

afterEach(async () => {
	for (const s of opened.splice(0)) {
		await s.close().catch(() => undefined);
	}
	if (dir) cleanupDir(dir);
});

describe("T-P0-2a: requestId idempotency (the P0 nail)", () => {
	it("resubmitting the same requestId returns the same submission", async () => {
		const { substrate, faux } = await openTestSubstrate();
		await track(substrate);
		faux.setResponses([fauxAssistantMessage("ok")]);
		const conv = await substrate.root();

		const first = await substrate.submit(conv, {
			type: "input",
			content: "hello",
			requestId: "feishu:om_1",
		});
		await first.wait(BACKGROUND_CONTEXT);

		const again = await substrate.submit(conv, {
			type: "input",
			content: "hello", // redelivery of the same event
			requestId: "feishu:om_1",
		});
		expect(again.id).toBe(first.id);
		expect(faux.state.callCount).toBe(1); // no second model call
	});

	it("survives a full restart: reopen finds the same submission by requestId", async () => {
		const { fauxProvider, createModels } = await import("@earendil-works/pi-ai");
		const faux1 = fauxProvider();
		const model = faux1.getModel();
		const cfgModel: ModelConfig = {
			provider: model.provider,
			modelId: model.id,
			baseUrl: "http://faux.test",
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		};
		const dbPath = `${dir}/harness.sqlite`;

		const mk = (faux: ReturnType<typeof fauxProvider>) => {
			const models = createModels();
			models.setProvider(faux.provider);
			return openSubstrate({
				storage: { kind: "sqlite", path: dbPath },
				models,
				model: cfgModel,
				agentHome: dir as string,
				instructions: "test agent",
			});
		};

		const s1 = await track(await mk(faux1));
		faux1.setResponses([fauxAssistantMessage("first answer")]);
		const conv1 = await s1.root();
		const sub = await s1.submit(conv1, {
			type: "input",
			content: "q1",
			requestId: "feishu:om_restart",
		});
		const settled = await sub.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		await s1.close();

		// Simulated crash-restart: a fresh process opens the same database.
		const faux2 = fauxProvider();
		const s2 = await track(await mk(faux2));
		const conv2 = await s2.root();
		const again = await s2.submit(conv2, {
			type: "input",
			content: "q1",
			requestId: "feishu:om_restart",
		});
		expect(again.id).toBe(sub.id);
		expect(faux2.state.callCount).toBe(0); // already answered; no rerun
	});
});

describe("substrate seam", () => {
	it("admits atomically and persists the watermark", async () => {
		const { substrate } = await openTestSubstrate();
		await track(substrate);
		const conv = await substrate.root();
		const id = await substrate.admit(
			conv,
			{ type: "input", content: "hi", requestId: "feishu:om_wm", whenBusy: "followUp" },
			{ chatId: "oc_home", ms: 123456 },
		);
		expect(typeof id).toBe("number"); // SubmissionId is a branded number
		expect(await substrate.watermark("oc_home")).toBe(123456);
	});

	it("answerText extracts the answer entry text", async () => {
		const { substrate, faux } = await openTestSubstrate();
		await track(substrate);
		faux.setResponses([fauxAssistantMessage("the answer")]);
		const conv = await substrate.root();
		const sub = await substrate.submit(conv, { type: "input", content: "q", requestId: "feishu:om_a" });
		const settled = await sub.wait(BACKGROUND_CONTEXT);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`unexpected ${settled.status}`);
		expect(await substrate.answerText(settled.answer)).toBe("the answer");
	});

	it("watermark defaults to undefined for unknown chats and updates overwrite", async () => {
		const { substrate } = await openTestSubstrate();
		await track(substrate);
		expect(await substrate.watermark("oc_none")).toBeUndefined();
		await substrate.setWatermark("oc_x", 1);
		await substrate.setWatermark("oc_x", 2);
		expect(await substrate.watermark("oc_x")).toBe(2);
	});
});
