import { describe, expect, it } from "vitest";
import { resolveDeliver } from "../src/deliver.ts";

const homes = { feishu: "oc_home" };

describe("deliver", () => {
	it("keeps an explicit chat even when origin is a different channel", () => {
		const resolved = resolveDeliver("feishu:oc_finance", { origin: { platform: "feishu", chatId: "oc_home" }, homes });
		expect(resolved).toEqual({ kind: "chat", platform: "feishu", chatId: "oc_finance" });
	});

	it("uses origin only when the target says origin", () => {
		expect(resolveDeliver("origin", { origin: { platform: "feishu", chatId: "oc_pr" }, homes })).toEqual({
			kind: "chat",
			platform: "feishu",
			chatId: "oc_pr",
		});
		expect(resolveDeliver("feishu", { homes })).toEqual({ kind: "chat", platform: "feishu", chatId: "oc_home" });
		expect(resolveDeliver("local", { homes })).toEqual({ kind: "local" });
	});

	it("carries a thread without changing the chat", () => {
		expect(resolveDeliver("feishu:oc_group:omt_1", { homes })).toEqual({
			kind: "chat",
			platform: "feishu",
			chatId: "oc_group",
			threadId: "omt_1",
		});
	});
});
