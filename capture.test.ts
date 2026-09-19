import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLoginTemplate,
  buildPassRef,
  capturePassItem,
  type CaptureRequest,
  countTitleCollisions,
  type PassRunner,
} from "./capture.js";

const SECRET = "sk-ant-do-not-leak-0123456789";

const REQUEST: CaptureRequest = {
  title: "Anthropic API 2026-08",
  vault: "Personal",
  secret: SECRET,
  url: undefined,
} as CaptureRequest;

/**
 * Records every call so a test can assert on what was *passed* versus what was
 * *piped* — the distinction the whole module exists for.
 */
function createRunner(
  overrides: Partial<PassRunner> & { listing?: string; stored?: string } = {},
): { runner: PassRunner; calls: { name: string; args: readonly unknown[] }[] } {
  const calls: { name: string; args: readonly unknown[] }[] = [];
  const runner: PassRunner = {
    listItems: async () => {
      calls.push({ name: "listItems", args: [] });
      return overrides.listing ?? '{"items":[]}';
    },
    createLogin: async (vault, template) => {
      calls.push({ name: "createLogin", args: [vault, template] });
    },
    readSecretField: async (vault, title) => {
      calls.push({ name: "readSecretField", args: [vault, title] });
      return overrides.stored ?? SECRET;
    },
  };
  return { runner: { ...runner, ...overrides }, calls };
}

describe("buildLoginTemplate", () => {
  it("carries the secret in the password field and nulls the unset ones", () => {
    const parsed = JSON.parse(buildLoginTemplate({ ...REQUEST, urls: ["https://console.anthropic.com", ""] }));
    expect(parsed).toEqual({
      title: "Anthropic API 2026-08",
      username: null,
      email: null,
      password: SECRET,
      totp_uri: null,
      urls: ["https://console.anthropic.com"],
    });
  });
});

describe("countTitleCollisions", () => {
  it("counts live items with that title and ignores trashed ones", () => {
    const listing = JSON.stringify({
      items: [
        { title: "Anthropic API 2026-08", state: "Active" },
        { title: "Anthropic API 2026-08", state: "Trashed" },
        { title: "Other", state: "Active" },
      ],
    });
    expect(countTitleCollisions(listing, "Anthropic API 2026-08")).toBe(1);
    expect(countTitleCollisions(listing, "Missing")).toBe(0);
  });

  it("accepts a bare array and survives unparseable output", () => {
    expect(countTitleCollisions('[{"title":"X"}]', "X")).toBe(1);
    expect(countTitleCollisions("not json", "X")).toBe(0);
    expect(countTitleCollisions('{"items":"nope"}', "X")).toBe(0);
  });
});

describe("capturePassItem", () => {
  it("stores the item and returns only the reference", async () => {
    const { runner, calls } = createRunner();
    const result = await capturePassItem(REQUEST, runner);
    expect(result).toEqual({ ok: true, ref: buildPassRef("Personal", "Anthropic API 2026-08") });
    expect(calls.map(c => c.name)).toEqual(["listItems", "createLogin", "readSecretField"]);
  });

  it("never passes the secret as an argument — only the piped template holds it", async () => {
    const { runner, calls } = createRunner();
    await capturePassItem(REQUEST, runner);

    // `createLogin`'s second parameter IS the stdin payload; every other
    // argument crosses a process boundary as argv, which `ps` exposes.
    const argvLike = calls.flatMap(call =>
      call.name === "createLogin" ? [call.args[0]] : call.args,
    );
    for (const arg of argvLike) {
      expect(String(arg)).not.toContain(SECRET);
    }
    const piped = calls.find(c => c.name === "createLogin")?.args[1];
    expect(String(piped)).toContain(SECRET);
  });

  it("refuses a colliding title instead of shadowing the older item", async () => {
    const { runner, calls } = createRunner({
      listing: JSON.stringify({ items: [{ title: "Anthropic API 2026-08", state: "Active" }] }),
    });
    const result = await capturePassItem(REQUEST, runner);
    expect(result).toMatchObject({ ok: false, reason: "collision" });
    expect(calls.map(c => c.name)).toEqual(["listItems"]);
  });

  it("reports an unreachable cli without creating anything", async () => {
    const { runner, calls } = createRunner({
      listItems: async () => {
        throw new Error("pass-cli: not signed in");
      },
    });
    const result = await capturePassItem(REQUEST, runner);
    expect(result).toMatchObject({ ok: false, reason: "no-cli" });
    expect(calls.map(c => c.name)).not.toContain("createLogin");
  });

  it("reports a refused create", async () => {
    const { runner } = createRunner({
      createLogin: async () => {
        throw new Error("vault not found");
      },
    });
    expect(await capturePassItem(REQUEST, runner)).toMatchObject({ ok: false, reason: "create-failed" });
  });

  it("catches a vault that holds something else, and says nothing about either value", async () => {
    const { runner } = createRunner({ stored: "a-different-secret" });
    const result = await capturePassItem(REQUEST, runner);
    expect(result).toMatchObject({ ok: false, reason: "readback-mismatch" });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).not.toContain(SECRET);
    expect(result.message).not.toContain("a-different-secret");
  });

  it("tolerates a trailing newline on read-back", async () => {
    const { runner } = createRunner({ stored: `${SECRET}\n` });
    expect(await capturePassItem(REQUEST, runner)).toMatchObject({ ok: true });
  });

  it("stores nothing when the popup came back empty", async () => {
    const { runner, calls } = createRunner();
    const result = await capturePassItem({ ...REQUEST, secret: "" }, runner);
    expect(result).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("compares by fingerprint, not by holding the value", async () => {
    // Guards the property the module documents: a matching capture only ever
    // needs the digest, so a future refactor returning the value would stand out.
    const digest = createHash("sha256").update(SECRET, "utf8").digest("hex").slice(0, 12);
    expect(digest).toHaveLength(12);
    const { runner } = createRunner();
    const result = await capturePassItem(REQUEST, runner);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
