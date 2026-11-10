import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessReadPath, READ_ONLY_WHITELIST } from "../src/durable-ext/approval-gate.ts";

describe("read jail", () => {
	it("allows a file inside the workspace and refuses a symlink that leaves it", async () => {
		const root = mkdtempSync(join(tmpdir(), "pots-root-"));
		const outside = mkdtempSync(join(tmpdir(), "pots-out-"));
		writeFileSync(join(root, "notes.txt"), "ok");
		writeFileSync(join(outside, "secret.txt"), "no");
		symlinkSync(join(outside, "secret.txt"), join(root, "link"));
		expect(await assessReadPath(root, "notes.txt")).toBeUndefined();
		expect(await assessReadPath(root, "link")).toBe("path outside workspace");
		expect(await assessReadPath(root, "../secret.txt")).toBe("path outside workspace");
		mkdirSync(root, { recursive: true });
		expect(await assessReadPath(root, ".env")).toBe("sensitive path: denied without approval");
	});

	it("does not treat memory writes as read-only", () => {
		expect(READ_ONLY_WHITELIST.has("memory_write")).toBe(false);
		expect(READ_ONLY_WHITELIST.has("memory_consolidate")).toBe(false);
		expect(READ_ONLY_WHITELIST.has("read")).toBe(true);
	});
});
