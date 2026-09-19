import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureViaPassSecret, type CaptureViaScriptResult } from "./capture-via-script.js";

/**
 * A fake `pass-secret.sh`: records its argv, prints a reference on stdout.
 * Never handles a secret value — the real script does, and its own suite
 * (`pass-secret.test.ts` in the harness) pins that.
 */
function fakeScript(dir: string, behavior: "ok" | "fail" | "silent"): string {
	const path = join(dir, `pass-secret-${behavior}.sh`);
	const body =
		behavior === "ok"
			? `#!/usr/bin/env bash
printf 'pass://Personal/Test Item/password\\n' >&2
printf 'pass://Personal/Test Item/password\\n'
`
			: behavior === "fail"
				? `#!/usr/bin/env bash
printf 'pass-secret: prompt cancelled — nothing was stored\\n' >&2
exit 1
`
				: `#!/usr/bin/env bash
printf 'nothing useful\\n'
exit 0
`;
	writeFileSync(path, body, { mode: 0o755 });
	return path;
}

describe("captureViaPassSecret", () => {
	it("runs the script with title and vault on argv and returns the parsed reference", async () => {
		const script = fakeScript(mkdtempSync(join(tmpdir(), "cvs-")), "ok");
		const result: CaptureViaScriptResult = await captureViaPassSecret(
			{ title: "Jev 2026-09", vault: "Personal" },
			{ scriptPath: script },
		);
		expect(result).toEqual({ ok: true, ref: "pass://Personal/Test Item/password" });
	});

	it("surfaces the script's stderr as the failure message on non-zero exit", async () => {
		const script = fakeScript(mkdtempSync(join(tmpdir(), "cvs-")), "fail");
		const result = await captureViaPassSecret(
			{ title: "Jev 2026-09", vault: "Personal" },
			{ scriptPath: script },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("cancelled");
	});

	it("refuses a zero exit that printed no pass:// reference", async () => {
		const script = fakeScript(mkdtempSync(join(tmpdir(), "cvs-")), "silent");
		const result = await captureViaPassSecret(
			{ title: "Jev 2026-09", vault: "Personal" },
			{ scriptPath: script },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("no pass://");
	});
});
