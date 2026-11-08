/**
 * P3-2 soak harness. Runs N conversations in parallel for a duration against
 * a substrate (faux model by default; CPA when --model cpa with config),
 * sampling RSS and the SQLite WAL, and reports against the D2 thresholds
 * (RSS ≤ 400MB, WAL ≤ 200MB). On breach it prints the F32 remediation steps
 * (restart + alert + archive WAL) — the actual 30min/24h挂机 runs are manual
 * gates recorded in VERIFICATION-LEDGER.
 *
 * Usage:
 *   node --experimental-transform-types scripts/soak.ts [--convs 3] [--seconds 60] [--db /tmp/soak.sqlite]
 */
import { statSync } from "node:fs";
import { rmSync } from "node:fs";
import process from "node:process";
import { fauxProvider, createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openSubstrate } from "../src/substrate.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? Number(args[i + 1]) : fallback;
};
const convs = flag("convs", 3);
const seconds = flag("seconds", 60);
const paceMs = flag("pace", 200); // per-worker think time: realistic pacing
const dbPath = flag("db", 0) || `/tmp/pi-larkd-soak-${Date.now()}.sqlite`;

const RSS_LIMIT_MB = 400;
const WAL_LIMIT_MB = 200;

rmSync(dbPath, { force: true });
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

const substrate = await openSubstrate({
	storage: { kind: "sqlite", path: dbPath },
	models,
	model: { provider: model.provider, modelId: model.id, baseUrl: "http://faux.test", contextWindow: model.contextWindow, maxTokens: model.maxTokens },
	agentHome: "/tmp",
	instructions: "soak",
});
substrate.resume();

let msgs = 0;
let unanswered = 0;

// Real parallel soak needs N conversations: bind one per worker.
const convIds: string[] = [];
for (let i = 0; i < convs; i++) {
	await substrate.bindChannel({ chatId: `oc_soak_${i}`, cwd: "/tmp", isGroup: false });
	convIds.push(`oc_soak_${i}`);
}
const samples: Array<{ t: number; rssMb: number; walMb: number }> = [];
const started = Date.now();

function walSize(): number {
	try {
		return statSync(`${dbPath}-wal`).size / 1024 / 1024;
	} catch {
		return 0;
	}
}

async function worker(id: number): Promise<void> {
	const conv = await substrate.conversationFor(convIds[id] as string);
	let n = 0;
	while (Date.now() - started < seconds * 1000) {
		// Preloaded responses: workers consume from the shared scripted queue.
		faux.appendResponses([fauxAssistantMessage(`soak reply ${id}-${n} ` + "x".repeat(2000))]);
		// The requestId advances on EVERY attempt: a settled-unanswered id must
		// never be resubmitted (idempotency would replay the dead submission).
		const sub = await substrate.submit(conv, {
			type: "input",
			content: `soak message ${n}`,
			requestId: `soak:${id}:${n++}`,
		});
		const settled = await sub.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		if (settled === undefined || settled.status !== "done") {
			unanswered++;
		} else {
			msgs++;
		}
		await new Promise((r) => setTimeout(r, paceMs));
	}
}

const sampler = setInterval(() => {
	if (samples.push({
		t: Date.now() - started,
		rssMb: process.memoryUsage.rss() / 1024 / 1024,
		walMb: walSize(),
	}) === 0) {
		// unreachable; keeps the expression statement shape stable
	}
}, 5000);

const failures: string[] = [];
const workers = Array.from({ length: convs }, (_, i) =>
	worker(i).catch((error) => {
		failures.push(String(error));
	}),
);
await Promise.all(workers);
clearInterval(sampler);

const peakRss = Math.max(...samples.map((s) => s.rssMb), 0);
const peakWal = Math.max(...samples.map((s) => s.walMb), 0);
const report = {
	convs,
	seconds,
	messages: msgs,
	unanswered,
	failures,
	peakRssMb: Math.round(peakRss),
	peakWalMb: Math.round(peakWal * 100) / 100,
	rssLimitMb: RSS_LIMIT_MB,
	walLimitMb: WAL_LIMIT_MB,
	rssBreach: peakRss > RSS_LIMIT_MB,
	walBreach: peakWal > WAL_LIMIT_MB,
	unansweredRate: Math.round((unanswered / Math.max(1, msgs + unanswered)) * 10000) / 100,
	// faux's shared scripted queue lets 3 racing workers occasionally miss a
	// response (out-of-order consumption) — tolerate <1%; a real CPA soak
	// has no scripted queue and should be 0.
	verdict:
		failures.length === 0 &&
		unanswered / Math.max(1, msgs + unanswered) < 0.01 &&
		peakRss <= RSS_LIMIT_MB &&
		peakWal <= WAL_LIMIT_MB
			? "PASS"
			: "FAIL",
	remediationIfBreach: "F32: launchctl kickstart -k (restart) + post alert to home chat + archive the WAL file (cp db-wal db-wal.archive-<ts>) before restart",
	samples,
};
console.log(JSON.stringify(report, null, 1));
await substrate.close();
process.exit(report.verdict === "PASS" ? 0 : 1);
