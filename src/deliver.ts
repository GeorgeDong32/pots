/** Hermes delivery grammar: explicit chat, home, origin, local, or all. */

export type DeliverTarget =
	| { kind: "explicit"; platform: string; chatId: string; threadId?: string }
	| { kind: "home"; platform: string }
	| { kind: "origin" }
	| { kind: "local" }
	| { kind: "all" };

export interface DeliverContext {
	origin?: { platform: string; chatId: string; threadId?: string };
	homes: Record<string, string>;
}

export type ResolvedDeliver =
	| { kind: "local" }
	| { kind: "all"; targets: Array<{ platform: string; chatId: string }> }
	| { kind: "chat"; platform: string; chatId: string; threadId?: string }
	| { kind: "error"; message: string };

export function parseDeliver(raw: string): DeliverTarget {
	const text = raw.trim();
	if (text === "local" || text === "origin" || text === "all") return { kind: text };
	const [platform, chatId, ...thread] = text.split(":");
	if (!platform) return { kind: "local" };
	if (chatId === undefined || chatId.length === 0) return { kind: "home", platform };
	return {
		kind: "explicit",
		platform,
		chatId,
		...(thread.length > 0 ? { threadId: thread.join(":") } : {}),
	};
}

/** Origin never overrides an explicit chat. A missing origin falls back to that platform's home. */
export function resolveDeliver(raw: string, ctx: DeliverContext): ResolvedDeliver {
	const target = parseDeliver(raw);
	if (target.kind === "local") return { kind: "local" };
	if (target.kind === "all") {
		const targets = Object.entries(ctx.homes).map(([platform, chatId]) => ({ platform, chatId }));
		return targets.length > 0 ? { kind: "all", targets } : { kind: "error", message: "no home channels configured" };
	}
	if (target.kind === "explicit") {
		return { kind: "chat", platform: target.platform, chatId: target.chatId, threadId: target.threadId };
	}
	if (target.kind === "origin") {
		if (ctx.origin !== undefined) {
			return { kind: "chat", platform: ctx.origin.platform, chatId: ctx.origin.chatId, threadId: ctx.origin.threadId };
		}
		const home = ctx.homes.feishu;
		return home !== undefined
			? { kind: "chat", platform: "feishu", chatId: home }
			: { kind: "error", message: "origin is missing and feishu has no home channel" };
	}
	const home = ctx.homes[target.platform];
	return home !== undefined
		? { kind: "chat", platform: target.platform, chatId: home }
		: { kind: "error", message: `${target.platform} has no home channel` };
}
