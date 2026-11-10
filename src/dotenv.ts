import { readFileSync } from "node:fs";

/** Load a dotenv file. Existing variables win, matching Hermes. */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): void {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return;
	}
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (env[key] !== undefined && env[key] !== "") continue;
		env[key] = unquote(line.slice(eq + 1).trim());
	}
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}
