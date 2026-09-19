/**
 * Capture a brand-new secret INTO Proton Pass from inside the TUI.
 *
 * `pass-cli` can read a stored secret and inject it into a child process, but it
 * has no way to *take* one, so a freshly minted key had only two channels:
 * paste it in chat (it then lives in the provider request and in
 * `agent/sessions/*.jsonl` forever), or leave the session for
 * `agent/scripts/pass-secret.sh`. This module is that script's guarantees,
 * reachable from a masked popup:
 *
 * - the secret crosses exactly one pipe, into `pass-cli`'s stdin;
 * - it never appears in any argv (`ps` is world-readable on macOS, and an agent
 *   running `ps` would land it in a transcript);
 * - it never touches disk, and never appears in a returned message;
 * - a colliding item title is refused, because Proton Pass allows duplicates and
 *   `--item-title` then silently returns the OLDER one — a wrong value served
 *   forever, the worst failure a secret store has;
 * - the stored value is proven by sha256 fingerprint, never by reading it back
 *   into the caller.
 *
 * Only the `pass://vault/title/password` reference leaves this file.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/** Field the reference points at. `pass-secret.sh` fixes the same one. */
const SECRET_FIELD = "password";

/** Prefix of the sha256 hex digest compared on read-back. */
const FINGERPRINT_LENGTH = 12;

export interface CaptureRequest {
	/** Item title inside the vault. Must not already exist (see the shadowing trap). */
	readonly title: string;
	readonly vault: string;
	/** The secret. Never logged, never returned, never passed as an argument. */
	readonly secret: string;
	readonly username?: string;
	readonly email?: string;
	readonly urls?: readonly string[];
}

export type CaptureFailure = "no-cli" | "collision" | "create-failed" | "readback-mismatch";

export type CaptureResult =
	| { readonly ok: true; readonly ref: string }
	| { readonly ok: false; readonly reason: CaptureFailure; readonly message: string };

/**
 * The three `pass-cli` calls this needs, isolated so tests can drive the whole
 * decision tree — including the argv-hygiene assertion — without a vault.
 */
export interface PassRunner {
	/** `item list --output json` */
	listItems(): Promise<string>;
	/** `item create login --from-template -`, template on STDIN. */
	createLogin(vault: string, template: string): Promise<void>;
	/** `item view --field password`; the value stays inside this process. */
	readSecretField(vault: string, title: string): Promise<string>;
}

/** JSON template `pass-cli item create login --from-template -` consumes. */
export function buildLoginTemplate(request: CaptureRequest): string {
	return JSON.stringify({
		title: request.title,
		username: request.username ?? null,
		email: request.email ?? null,
		password: request.secret,
		totp_uri: null,
		urls: (request.urls ?? []).filter(url => url.length > 0),
	});
}

/**
 * Live items carrying `title`, from `item list --output json`.
 *
 * Trashed items do not shadow, and unparseable output means "cannot prove a
 * collision" — the caller decides what to do with a zero it did not trust.
 */
export function countTitleCollisions(listJson: string, title: string): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(listJson);
	} catch {
		return 0;
	}
	const rows = Array.isArray(parsed)
		? parsed
		: ((parsed as { items?: unknown } | null)?.items ?? []);
	if (!Array.isArray(rows)) return 0;
	let count = 0;
	for (const row of rows) {
		if (row === null || typeof row !== "object") continue;
		const entry = row as { title?: unknown; state?: unknown };
		if (entry.title === title && entry.state !== "Trashed") count++;
	}
	return count;
}

export function buildPassRef(vault: string, title: string): string {
	return `pass://${vault}/${title}/${SECRET_FIELD}`;
}

function fingerprint(value: string): string {
	return createHash("sha256")
		.update(value.replace(/\n+$/u, ""), "utf8")
		.digest("hex")
		.slice(0, FINGERPRINT_LENGTH);
}

/** Run `pass-cli` with the secret confined to stdin. */
function runPassCli(args: string[], options: { stdin?: string; reason: string }): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn("pass-cli", args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PROTON_PASS_AGENT_REASON: options.reason },
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
	child.on("error", reject);
	child.on("close", code => {
		if (code === 0) resolve(stdout);
		// stderr can name a locked session or a bad vault; it never carries the
		// value we wrote, which only ever went to stdin.
		else reject(new Error(stderr.trim() || `pass-cli exited with code ${String(code)}`));
	});
	// The secret leaves this process here and nowhere else.
	child.stdin.end(options.stdin ?? "", "utf8");
	return promise;
}

export const defaultPassRunner: PassRunner = {
	listItems: () => runPassCli(["item", "list", "--output", "json"], { reason: "pi-proton-pass: duplicate-title check before capture" }),
	createLogin: async (vault, template) => {
		await runPassCli(["item", "create", "login", "--from-template", "-", "--vault-name", vault], {
			stdin: template,
			reason: "pi-proton-pass: store a secret the user just typed",
		});
	},
	readSecretField: (vault, title) =>
		runPassCli(["item", "view", "--vault-name", vault, "--item-title", title, "--field", SECRET_FIELD], {
			reason: "pi-proton-pass: fingerprint read-back after capture",
		}),
};

/**
 * Store `request.secret` as a new login item and return only its reference.
 *
 * Fails closed: every failure leaves either nothing stored, or an item the
 * caller is told not to trust. No path returns the secret.
 */
export async function capturePassItem(
	request: CaptureRequest,
	runner: PassRunner = defaultPassRunner,
): Promise<CaptureResult> {
	if (request.secret.length === 0) {
		return { ok: false, reason: "create-failed", message: "Nothing was typed — nothing was stored." };
	}

	let listing: string;
	try {
		listing = await runner.listItems();
	} catch (error) {
		return {
			ok: false,
			reason: "no-cli",
			message: `Proton Pass is not reachable (${error instanceof Error ? error.message : String(error)}).`,
		};
	}

	if (countTitleCollisions(listing, request.title) > 0) {
		return {
			ok: false,
			reason: "collision",
			message:
				`An item titled "${request.title}" already exists. A second one would shadow it — ` +
				"Proton Pass keeps returning the older item. Pick a distinct title (dating it works well).",
		};
	}

	try {
		await runner.createLogin(request.vault, buildLoginTemplate(request));
	} catch (error) {
		return {
			ok: false,
			reason: "create-failed",
			message: `Proton Pass refused the item (${error instanceof Error ? error.message : String(error)}).`,
		};
	}

	let storedFingerprint: string;
	try {
		storedFingerprint = fingerprint(await runner.readSecretField(request.vault, request.title));
	} catch (error) {
		return {
			ok: false,
			reason: "readback-mismatch",
			message: `Stored, but the read-back failed (${error instanceof Error ? error.message : String(error)}). Check the item by hand.`,
		};
	}

	if (storedFingerprint !== fingerprint(request.secret)) {
		return {
			ok: false,
			reason: "readback-mismatch",
			message: "Read-back mismatch: the vault does not hold what you typed. Inspect the item by hand.",
		};
	}

	return { ok: true, ref: buildPassRef(request.vault, request.title) };
}
