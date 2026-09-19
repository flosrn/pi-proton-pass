/**
 * Launch `agent/scripts/pass-secret.sh` from inside a session, so a capture
 * needs ONE masked dialog and no wizard.
 *
 * Why a subprocess and not the in-TUI popup of `credential-api.ts`:
 * the script's masked channel is the macOS hidden-answer dialog (or a masked
 * TTY) — it renders outside the terminal entirely, has its own duplicate-title
 * guard, its own fingerprint read-back, and its value crosses exactly one pipe
 * into `pass-cli`'s stdin. This process only ever sees the script's stdout:
 * the `pass://vault/title/password` reference (or nothing, on failure).
 *
 * The value therefore never crosses: this file, `index.ts`, an argv, the
 * transcript, or the session JSONL. The script's test suite
 * (`pass-secret.test.ts` in the harness) already pins those guarantees.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** The script's home. Exported as the seam tests use to override the path. */
export const PASS_SECRET_SCRIPT = join(homedir(), ".omp", "agent", "scripts", "pass-secret.sh");

export interface CaptureViaScriptRequest {
	/** Item title inside the vault. The script refuses a title that exists. */
	readonly title: string;
	readonly vault: string;
	/** Recorded in PROTON_PASS_AGENT_REASON — the audit trail names the why. */
	readonly reason?: string;
}

export type CaptureViaScriptResult =
	| { readonly ok: true; readonly ref: string }
	| { readonly ok: false; readonly message: string };

/**
 * Run the script. Non-zero exit or a stdout that does not parse as one
 * `pass://…/password` line is a named failure — never a guess.
 *
 * The dialog is macOS System Events: it needs a GUI session. On a headless
 * host the script itself dies with its own remediation message, which we
 * surface unchanged.
 */
export function captureViaPassSecret(
	request: CaptureViaScriptRequest,
	options: { scriptPath?: string } = {},
): Promise<CaptureViaScriptResult> {
	const script = options.scriptPath ?? PASS_SECRET_SCRIPT;
	const args = ["--title", request.title, "--vault", request.vault];
	if (request.reason) args.push("--reason", request.reason);

	const { promise, resolve } = Promise.withResolvers<CaptureViaScriptResult>();
	const child = spawn("bash", [script, ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PROTON_PASS_AGENT_REASON: request.reason ?? "pi-proton-pass: capture via masked dialog" },
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", chunk => {
		stdout += String(chunk);
	});
	child.stderr.on("data", chunk => {
		stderr += String(chunk);
	});
	child.on("error", error => {
		resolve({ ok: false, message: `Could not launch ${script}: ${String(error)}` });
	});
	child.on("close", code => {
		if (code !== 0) {
			resolve({
				ok: false,
				// stderr names the failure (cancelled prompt, duplicate title,
				// read-back mismatch) and never carries the secret.
				message: stderr.trim() || `pass-secret.sh exited with code ${String(code)}`,
			});
			return;
		}
		const ref = /^pass:\/\/[^\n]+\/password\s*$/m.exec(stdout);
		resolve(
			ref
				? { ok: true, ref: ref[0].trim() }
				: { ok: false, message: "pass-secret.sh printed no pass:// reference — capture did not complete." },
		);
	});
	return promise;
}
