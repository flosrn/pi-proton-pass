import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import factory from "./index.js";

interface RegistrationLog {
  tools: string[];
  commands: string[];
  events: string[];
}

function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
  const log: RegistrationLog = { tools: [], commands: [], events: [] };
  const notImplemented = (method: string) => () => {
    throw new Error(`ExtensionAPI.${method} not implemented in test stub`);
  };
  const api = {
    on: ((event: string) => {
      log.events.push(event);
    }) as unknown as ExtensionAPI["on"],
    registerTool: ((tool: { name: string }) => {
      log.tools.push(tool.name);
    }) as unknown as ExtensionAPI["registerTool"],
    registerCommand: ((name: string) => {
      log.commands.push(name);
    }) as unknown as ExtensionAPI["registerCommand"],
    registerShortcut: notImplemented("registerShortcut"),
    registerFlag: notImplemented("registerFlag"),
    getFlag: notImplemented("getFlag"),
    registerMessageRenderer: notImplemented("registerMessageRenderer"),
    sendMessage: notImplemented("sendMessage"),
    sendUserMessage: notImplemented("sendUserMessage"),
    appendEntry: notImplemented("appendEntry"),
    setSessionName: notImplemented("setSessionName"),
    getSessionName: notImplemented("getSessionName"),
    setLabel: notImplemented("setLabel"),
    exec: notImplemented("exec"),
    getActiveTools: notImplemented("getActiveTools"),
    getAllTools: notImplemented("getAllTools"),
    setActiveTools: notImplemented("setActiveTools"),
    getCommands: notImplemented("getCommands"),
    setModel: notImplemented("setModel"),
  } as unknown as ExtensionAPI;
  return { api, log };
}

/**
 * Point the extension's `auth.json` at a scratch agent dir. `store.ts` resolves
 * it from `PI_CODING_AGENT_DIR`, so the two registration branches below are
 * decided by fixture content instead of by whatever the developer's real
 * `~/.omp/agent/auth.json` happens to hold.
 */
async function withAuthJson(content: unknown): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pp-auth-"));
  await writeFile(join(dir, "auth.json"), JSON.stringify(content), "utf8");
  process.env.PI_CODING_AGENT_DIR = dir;
}

describe("@flosrn/pi-proton-pass", () => {
  const agentDirBefore = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
  });

  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers diagnose + setup", async () => {
    await withAuthJson({});
    const { api, log } = createApiStub();
    await factory(api);
    expect(log.tools).toContain("pp_diagnose");
    expect(log.commands).toContain("proton-pass_setup");
    expect(log.commands).toContain("proton-pass_diagnose");
  }, 30000);

  // Shadowing a built-in name costs `bash` its framed host card (the host marks
  // a re-registered name non-built-in), so secrets must reach bash some other
  // way — whether auth.json holds any or not.
  it("never shadows the built-in bash, even with secrets configured", async () => {
    await withAuthJson({ PP_TEST_TOKEN: "literal-not-a-pass-ref" });
    const { api, log } = createApiStub();
    await factory(api);
    expect(log.tools).not.toContain("bash");
  }, 30000);

  it("exports configured secrets into the process env the built-in bash inherits", async () => {
    await withAuthJson({ PP_TEST_TOKEN: "literal-not-a-pass-ref" });
    try {
      await factory(createApiStub().api);
      expect(process.env.PP_TEST_TOKEN).toBe("literal-not-a-pass-ref");
    } finally {
      delete process.env.PP_TEST_TOKEN;
    }
  }, 30000);
});
