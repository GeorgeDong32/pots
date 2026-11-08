import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Read a generic password from the macOS Keychain (F13: secrets never touch
 * the config file, the environment block of the plist, or the repo).
 * The `security` CLI may prompt for authorization on first access per item;
 * the daemon treats a missing item as a startup error, never a fallback.
 */
export async function readKeychainSecret(service: string, account: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("/usr/bin/security", [
			"find-generic-password",
			"-s",
			service,
			"-a",
			account,
			"-w",
		]);
		const secret = stdout.trim();
		if (!secret) throw new Error(`Keychain item ${service}/${account} is empty`);
		return secret;
	} catch (error) {
		throw new Error(
			`cannot read Keychain item service=${service} account=${account} (` +
				`create it with: security add-generic-password -s ${service} -a ${account} -w` +
				`): ${(error as Error).message}`,
			{ cause: error },
		);
	}
}
