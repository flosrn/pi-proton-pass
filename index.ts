/**
 * Proton Pass integration for the Pi coding agent.
 *
 * Writes `!pass read 'pass://…'` references to auth.json and exports resolved
 * values into the host process env, which the built-in bash inherits. The LLM
 * never sees secret values.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piRuntime from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import {
  confirmInBorderedPopup,
  inputInBorderedPopup,
  selectInBorderedPopup,
} from "./ui/bordered-popups.js";
import {
  addAuthEntry,
  findFirstPassRef,
  getAuthFilePath,
  parsePassReadRef,
  PASS_READ_PREFIX,
  readAuthJson,
  resolveShellValue,
} from "./store.js";
import { formatPassStatus, getPassStatus, loadCuratedTools, pickPassReference } from "./pass.js";
import type { CuratedTool } from "./pass.js";
import { captureViaPassSecret } from "./capture-via-script.js";

export {
  captureSecretIntoVault,
  changeSecret,
  deleteSecret,
  isProtonPassAvailable,
  onboardSecret,
  resolveSecret,
  verifySecret,
} from "./credential-api.js";

export {
  addAuthEntry,
  deleteAuthEntry,
  findFirstPassRef,
  parsePassUri,
  readAuthJson,
  resolveShellValue,
  writeProviderAuthEntry,
} from "./store.js";

export { getPassStatus, pickPassReference } from "./pass.js";

const KNOWN_PROVIDER_KEYS = new Set([
  "anthropic",
  "openai",
  "azure-openai-responses",
  "deepseek",
  "google",
  "mistral",
  "groq",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "opencode",
  "opencode-go",
  "huggingface",
  "fireworks",
  "together",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
]);

let currentShellEnv: Record<string, string> = {};
let curatedTools: CuratedTool[] = [];

export function getShellEnvNames(): string[] {
  return Object.keys(currentShellEnv);
}

async function loadShellEnvMap(): Promise<Record<string, string>> {
  const parsed = await readAuthJson();
  const map = new Map<string, string>();
  for (const [key, val] of Object.entries(parsed)) {
    if (KNOWN_PROVIDER_KEYS.has(key)) continue;
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    const resolved = await resolveShellValue(val);
    if (resolved !== null) map.set(key, resolved);
  }
  return Object.fromEntries(map);
}

export async function warmPassSessionIfNeeded(): Promise<void> {
  try {
    const parsed = await readAuthJson();
    const firstRef = findFirstPassRef(parsed);
    if (!firstRef) return;
    const ref = parsePassReadRef(firstRef);
    if (!ref) return;
    await resolveShellValue(`${PASS_READ_PREFIX}'${ref}'`);
  } catch {
    // Best effort — a failed warm-up must not disrupt startup.
  }
}

const diagnoseSchema = Type.Object({});
export type DiagnoseInput = Static<typeof diagnoseSchema>;

export default async function (pi: ExtensionAPI): Promise<void> {
  currentShellEnv = await loadShellEnvMap();
  curatedTools = await loadCuratedTools();
  await warmPassSessionIfNeeded();

  // Why process.env and not a bash wrapper. Registering a tool under a
  // built-in's name makes the host mark it non-built-in (`setToolBuiltIn(name,
  // false)`), and its transcript card then resolves with `useBuiltInRenderer:
  // false`: bash loses the framed card — syntax-highlighted command, `Output`
  // divider, `⟨Wall: …s⟩` footer. Measured on omp 18.0.6, and hit again on
  // 2026-09-23 when the first secret landed in auth.json and the old "wrap only
  // when there is something to inject" gate opened.
  //
  // The built-in bash spawns from `filterChildShellEnv(Bun.env)`
  // (pi-utils procmgr `buildSpawnEnv`), cached on first use. Extensions load
  // before the first tool call, so exporting here reaches every bash call of
  // the session with the built-in card intact. Cost: other children of the
  // host (MCP stdio servers, LSP) inherit the values too, and a secret added
  // after startup reaches bash only after the host restarts.
  const injected = new Set<string>();
  const exportShellEnv = (): void => {
    for (const name of injected) {
      if (!(name in currentShellEnv)) delete process.env[name];
    }
    injected.clear();
    for (const [name, value] of Object.entries(currentShellEnv)) {
      process.env[name] = value;
      injected.add(name);
    }
  };
  exportShellEnv();

  if (typeof piRuntime.createLocalBashOperations === "function") {
    pi.on("user_bash", () => ({ operations: piRuntime.createLocalBashOperations() }));
  }

  pi.on("session_start", async () => {
    currentShellEnv = await loadShellEnvMap();
    curatedTools = await loadCuratedTools();
    await warmPassSessionIfNeeded();
    exportShellEnv();
  });

  async function getDiagnosticReport() {
    const status = await getPassStatus();
    let report = `${formatPassStatus(status)}\n\n`;

    const injectedNames = getShellEnvNames();
    report += "Shell env injection (transparent for agent bash):\n";
    if (injectedNames.length > 0) {
      report += `Active vars (names only): ${injectedNames.join(", ")}\n`;
      report += "Source: top-level keys in auth.json using !pass read (or literals).\n";
      report +=
        "Exported into the host process env at startup; the built-in bash inherits\n" +
        "them and keeps its framed card. The LLM never sees the values.\n" +
        "A key added since startup reaches bash after the host restarts.\n";
    } else {
      report += "No shell env vars currently injected from auth.json.\n";
      report +=
        'Add e.g. "GH_TOKEN": "!pass read \'pass://Vault/Item/password\'" then restart.\n';
    }

    return {
      report: report.trim(),
      details: {
        passStatus: status,
        injectedShellEnvNames: injectedNames,
      },
    };
  }

  pi.registerTool({
    name: "pp_diagnose",
    label: "Proton Pass Diagnostics",
    description:
      "Check pass-cli status, sign-in state, and active shell env injection from auth.json. Never returns secret values, only variable names.",
    parameters: diagnoseSchema,
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const { report, details } = await getDiagnosticReport();
      return {
        content: [{ type: "text", text: report }],
        details,
      };
    },
  });

  pi.registerCommand("proton-pass_diagnose", {
    description:
      "Run Proton Pass diagnostics: pass-cli status and injected env var names (never values).",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Running Proton Pass diagnostics...", "info");
      const { report } = await getDiagnosticReport();
      ctx.ui.notify(report, "info");
    },
  });

  pi.registerCommand("proton-pass_setup", {
    description:
      "Capture a secret into Proton Pass via the masked dialog and wire it into auth.json — one prompt, zero wizard. Usage: /proton-pass_setup ENV_VAR [item title]",
    handler: async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) => {
      const authPath = getAuthFilePath();

      // Args: ENV_VAR [vault/title]. Everything optional is defaulted, nothing is a menu.
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const envVarArg = parts[0] ?? "";
      const rest = parts.slice(1).join(" ");
      // "Vault/Item title" names the vault and the item; a bare rest is just the title.
      const vaultInTitle = /^([A-Za-z0-9 _-]+)\/(.+)$/.exec(rest);
      const vault = vaultInTitle?.[1] ?? "Personal";
      const title = vaultInTitle?.[2] ?? rest;

      let envVar = envVarArg;
      if (!envVar) {
        envVar = (await inputInBorderedPopup(ctx, {
          title: "Environment variable",
          prompt: "UPPER_SNAKE_CASE name the secret will be injected as (e.g. JEV_API_KEY)",
          helpText: "Enter to confirm • Esc = cancel",
        })) ?? "";
        if (!envVar) {
          ctx.ui.notify("Cancelled — nothing was captured.", "info");
          return;
        }
      }
      if (!/^[A-Z0-9_]+$/.test(envVar)) {
        ctx.ui.notify(`"${envVar}" is not UPPER_SNAKE_CASE — nothing was captured.`, "error");
        return;
      }
      const itemTitle = title || `${envVar} (OMP)`;

      // THE ONE INTERACTION: pass-secret.sh opens its own masked dialog (macOS
      // hidden-answer, or masked TTY) and pipes the value straight into
      // pass-cli's stdin. The value never crosses this process, this file, an
      // argv, or the transcript. Fingerprint read-back is the script's own.
      ctx.ui.notify(
        `A masked dialog is opening — paste the ${envVar} secret into it.\nNothing is stored until you confirm in that dialog.`,
        "info",
      );
      const captured = await captureViaPassSecret({
        title: itemTitle,
        vault,
        reason: `pi-proton-pass: /proton-pass_setup ${envVar}`,
      });
      if (!captured.ok) {
        ctx.ui.notify(`Capture failed or cancelled — nothing was written.\n${captured.message}`, "warning");
        return;
      }
      const passRef = captured.ref;

      const previewLine = `"${envVar}": "!pass read '${passRef}'"`;
      const previewMsg =
        `File: ${authPath}\n\n${previewLine}\n\n` +
        "After write: run /reload (or restart). The spawn hook will inject the variable into bash.\n" +
        "Use /proton-pass_diagnose to verify (names only; values never leave the host).";

      const confirmed = await confirmInBorderedPopup(ctx, {
        title: "Add this to auth.json?",
        message: previewMsg,
      });
      if (!confirmed) {
        ctx.ui.notify(`Captured in Proton Pass as "${itemTitle}", but NOT wired: re-run later or add by hand:\n${previewLine}`, "warning");
        return;
      }

      let writeRes = await addAuthEntry(envVar, passRef);

      if (!writeRes.success && writeRes.message.includes("already exists")) {
        const overwrite = await confirmInBorderedPopup(ctx, {
          title: `Key "${envVar}" already exists, overwrite?`,
          message: "Replace the current value in auth.json?",
        });
        if (overwrite) {
          writeRes = await addAuthEntry(envVar, passRef, { overwrite: true });
        } else {
          ctx.ui.notify(writeRes.message, "warning");
          return;
        }
      }

      if (writeRes.success) {
        ctx.ui.notify(`✅ ${envVar} captured in Proton Pass and wired to auth.json (0600).`, "info");
        const doReload = await confirmInBorderedPopup(ctx, {
          title: "Activate now?",
          message: "Run /reload so the spawn hook starts injecting it this session?",
        });
        if (doReload) {
          await ctx.reload();
        } else {
          ctx.ui.notify("Run `/reload` when ready.", "info");
        }
      } else {
        ctx.ui.notify(writeRes.message, "warning");
      }
    },
  });
}
