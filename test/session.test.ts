import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { openTestSubstrate } from "./helpers-p1.ts";

describe("thread sessions", () => {
	it("gives each Feishu thread its own conversation and leaves the channel root alone", async () => {
		const { substrate, faux } = await openTestSubstrate({ homeChatId: "oc_home", ownerOpenId: "ou_owner" });
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("root")]);
		await substrate.bindChannel({ chatId: "oc_group", cwd: "/tmp/group", isGroup: true });
		const root = await substrate.admitBinding("oc_group", {
			messageId: "om_root",
			text: "root",
			senderId: "ou_owner",
			isBot: false,
			isMention: true,
			sentAt: 1,
		});
		const first = await substrate.admitBinding("oc_group", {
			messageId: "om_a",
			text: "a",
			senderId: "ou_owner",
			isBot: false,
			isMention: true,
			sentAt: 2,
			threadId: "om_a",
		});
		const second = await substrate.admitBinding("oc_group", {
			messageId: "om_b",
			text: "b",
			senderId: "ou_owner",
			isBot: false,
			isMention: true,
			sentAt: 3,
			threadId: "om_b",
		});
		expect(root.kind).toBe("admitted");
		expect(first.kind).toBe("admitted");
		expect(second.kind).toBe("admitted");
		const threads = (await substrate.bindings()).bindings.oc_group?.threads ?? {};
		expect(threads.om_a).not.toBe(threads.om_b);
		expect(threads.om_a).not.toBe((await substrate.bindings()).bindings.oc_group?.conversationId);
		const rootConv = await substrate.sessionConversation("oc_group");
		const threadConv = await substrate.sessionConversation("oc_group", "om_a");
		expect(Number(threadConv.id)).toBe(threads.om_a);
		expect(Number(threadConv.id)).not.toBe(Number(rootConv.id));
		expect(await substrate.chatOfConversation(Number(threadConv.id))).toBe("oc_group");
		await substrate.close();
	});
});
