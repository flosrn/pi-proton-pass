/**
 * Credential API round-trip tests — no mocks of project code.
 * Temp auth.json via PI_CODING_AGENT_DIR. Literals + fail-closed bangs.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSecret, onboardSecret, resolveSecret, verifySecret } from "./credential-api.js";
import { findFirstPassRef, writeProviderAuthEntry } from "./index.js";

let dir: string;
let prevAgentDir: string | undefined;

function authPath(): string {
  return join(dir, "auth.json");
}

async function writeAuth(obj: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(authPath(), `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function readAuth(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(authPath(), "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pp-credapi-"));
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(async () => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  await rm(dir, { recursive: true, force: true });
});

describe("resolveSecret", () => {
  it("resolves a provider-shaped literal", async () => {
    await writeAuth({ demo: { type: "api_key", key: "resolved-secret" } });
    expect(await resolveSecret("demo")).toBe("resolved-secret");
  });

  it("resolves a bare legacy literal string entry", async () => {
    await writeAuth({ demo: "literal-value" });
    expect(await resolveSecret("demo")).toBe("literal-value");
  });

  it("fails closed on an unknown bang — never shells it", async () => {
    await writeAuth({
      demo: {
        type: "api_key",
        key: "!PROTON_PASS_AGENT_REASON=x pass-cli item view --field password",
      },
    });
    expect(await resolveSecret("demo")).toBeUndefined();
  });

  it("fails closed on a !pass read that cannot resolve", async () => {
    await writeAuth({ demo: { type: "api_key", key: "!pass read 'pass://nope/nope/password'" } });
    expect(await resolveSecret("demo")).toBeUndefined();
  });

  it("returns undefined for a missing name", async () => {
    await writeAuth({ other: { type: "api_key", key: "x" } });
    expect(await resolveSecret("demo")).toBeUndefined();
  });
});

describe("writeProviderAuthEntry + round-trip", () => {
  it("writes the provider shape and reads it back", async () => {
    const res = await writeProviderAuthEntry("demo", "written-secret");
    expect(res.success).toBe(true);
    expect((await readAuth()).demo).toEqual({ type: "api_key", key: "written-secret" });
    expect(await resolveSecret("demo")).toBe("written-secret");
  });

  it("refuses to clobber an existing key without overwrite", async () => {
    await writeProviderAuthEntry("demo", "first");
    const res = await writeProviderAuthEntry("demo", "second");
    expect(res.success).toBe(false);
    expect(res.alreadyExists).toBe(true);
    expect(await resolveSecret("demo")).toBe("first");
  });

  it("serializes concurrent writes under the lock (both keys land)", async () => {
    await Promise.all([writeProviderAuthEntry("alpha", "a"), writeProviderAuthEntry("beta", "b")]);
    const stored = await readAuth();
    expect(stored.alpha).toEqual({ type: "api_key", key: "a" });
    expect(stored.beta).toEqual({ type: "api_key", key: "b" });
  });
});

describe("verifySecret", () => {
  it("reports resolved=true for a value, without returning the value", async () => {
    await writeAuth({ demo: { type: "api_key", key: "present" } });
    expect(await verifySecret("demo")).toEqual({ ok: true, resolved: true });
  });

  it("reports resolved=false with an error when nothing resolves", async () => {
    await writeAuth({ demo: { type: "api_key", key: "!pass read 'pass://nope/nope/password'" } });
    const v = await verifySecret("demo");
    expect(v.ok).toBe(false);
    expect(v.resolved).toBe(false);
    expect(v.error).toBeTruthy();
  });
});

describe("deleteSecret", () => {
  it("removes an entry so it no longer resolves", async () => {
    await writeProviderAuthEntry("demo", "gone");
    expect(await resolveSecret("demo")).toBe("gone");
    expect((await deleteSecret("demo")).ok).toBe(true);
    expect(Object.hasOwn(await readAuth(), "demo")).toBe(false);
    expect(await resolveSecret("demo")).toBeUndefined();
  });

  it("reports ok=false when there is nothing to remove", async () => {
    await writeAuth({});
    expect((await deleteSecret("demo")).ok).toBe(false);
  });
});

describe("onboarding ctx typing regression", () => {
  it("onboardSecret is callable from every ctx that exposes `ui` — no cast", () => {
    const callsites = {
      fromToolExecute: (ctx: ExtensionContext) => onboardSecret(ctx, { name: "d", label: "D" }),
      fromCommandHandler: (ctx: ExtensionCommandContext) =>
        onboardSecret(ctx, { name: "d", label: "D" }),
      fromUiDouble: (ctx: { ui: ExtensionContext["ui"] }) =>
        onboardSecret(ctx, { name: "d", label: "D" }),
    };
    expect(Object.keys(callsites)).toHaveLength(3);
  });
});

describe("onboardSecret manual-entry branch (pass-cli unavailable)", () => {
  it("writes the provider-shaped literal via a bare `{ ui }` double", async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const ui = {
        custom: async () => "manual-test-key",
        notify: () => {},
        setStatus: () => {},
      } as unknown as ExtensionContext["ui"];

      const res = await onboardSecret({ ui }, { name: "demo", label: "Demo" });

      expect(res.ok).toBe(true);
      expect((await readAuth()).demo).toEqual({ type: "api_key", key: "manual-test-key" });
      expect(await resolveSecret("demo")).toBe("manual-test-key");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
});

describe("findFirstPassRef", () => {
  it("finds a nested provider-shaped !pass read", () => {
    expect(
      findFirstPassRef({
        context7: { type: "api_key", key: "!pass read 'pass://Personal/X/password'" },
      }),
    ).toBe("!pass read 'pass://Personal/X/password'");
  });

  it("ignores literals", () => {
    expect(findFirstPassRef({ demo: "literal" })).toBeNull();
  });
});
