import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
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

describe("@flosrn/pi-proton-pass", () => {
  it("exports a default factory function", () => {
    expect(typeof factory).toBe("function");
  });

  it("registers diagnose + setup and wraps bash", async () => {
    const { api, log } = createApiStub();
    await factory(api);
    expect(log.tools).toContain("pp_diagnose");
    expect(log.tools).toContain("bash");
    expect(log.commands).toContain("proton-pass_setup");
    expect(log.commands).toContain("proton-pass_diagnose");
  }, 30000);
});
