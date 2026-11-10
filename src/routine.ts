import { parseSchedule, type Schedule } from "./schedule.ts";

/** A routine is a document. Job names are data, not code branches. */
export interface RoutineDraft {
	id: string | null;
	name: string;
	enabled: boolean;
	schedule: Schedule;
	deliver: string;
	origin: { platform: string; chatId: string } | null;
	noAgent: boolean;
	script: string | null;
	prompt: string;
	workdir: string | null;
	continuity: boolean;
	contextFrom: string[];
	toolsets: string[];
	model: string | null;
	provider: string | null;
	reasoning: string | null;
}

export function importHermesJob(job: Record<string, unknown>, now = Date.now()): RoutineDraft {
	const schedule = job.schedule;
	const expr =
		schedule !== null && typeof schedule === "object" && "expr" in schedule && typeof schedule.expr === "string"
			? schedule.expr
			: typeof schedule === "string"
				? schedule
				: "";
	const origin = job.origin;
	const originRecord =
		origin !== null && typeof origin === "object" && "platform" in origin && "chat_id" in origin
			? { platform: String(origin.platform), chatId: String(origin.chat_id) }
			: null;
	const contextFrom = job.context_from;
	return {
		id: typeof job.id === "string" ? job.id : null,
		name: typeof job.name === "string" && job.name.length > 0 ? job.name : "routine",
		enabled: job.enabled !== false && job.state !== "paused",
		schedule: parseSchedule(expr, now),
		deliver: typeof job.deliver === "string" && job.deliver.length > 0 ? job.deliver : "origin",
		origin: originRecord,
		noAgent: job.no_agent === true,
		script: typeof job.script === "string" && job.script.length > 0 ? job.script : null,
		prompt: typeof job.prompt === "string" ? job.prompt : "",
		workdir: typeof job.workdir === "string" && job.workdir.length > 0 ? job.workdir : null,
		continuity: job.continuity === true || (Array.isArray(contextFrom) && contextFrom.includes("self")),
		contextFrom: Array.isArray(contextFrom) ? contextFrom.filter((item): item is string => typeof item === "string") : [],
		toolsets: Array.isArray(job.enabled_toolsets)
			? job.enabled_toolsets.filter((item): item is string => typeof item === "string")
			: [],
		model: typeof job.model === "string" ? job.model : null,
		provider: typeof job.provider === "string" ? job.provider : null,
		reasoning: typeof job.reasoning_effort === "string" ? job.reasoning_effort : null,
	};
}

export function executionMode(draft: RoutineDraft): "script" | "agent" | "agent-script" {
	if (draft.noAgent) return "script";
	if (draft.script !== null) return "agent-script";
	return "agent";
}
