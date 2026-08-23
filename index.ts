/**
 * Proton Pass integration for the Pi coding agent.
 *
 * Writes `!pass read 'pass://…'` references to auth.json and injects resolved
 * values into agent bash via spawnHook. The LLM never sees secret values.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piRuntime from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
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

export {
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

  const cwd = process.cwd();
  const injectedBash = createBashTool(cwd, {
    spawnHook: ({ command, cwd: hookCwd, env }) => ({
      command,
      cwd: hookCwd,
      env: { ...env, ...currentShellEnv },
    }),
  });
  pi.registerTool(injectedBash);

  if (typeof piRuntime.createLocalBashOperations === "function") {
    pi.on("user_bash", () => ({ operations: piRuntime.createLocalBashOperations() }));
  }

  pi.on("session_start", async () => {
    currentShellEnv = await loadShellEnvMap();
    curatedTools = await loadCuratedTools();
    await warmPassSessionIfNeeded();
  });

  async function getDiagnosticReport() {
    const status = await getPassStatus();
    let report = `${formatPassStatus(status)}\n\n`;

    const injectedNames = getShellEnvNames();
    report += "Shell env injection (transparent for agent bash):\n";
    if (injectedNames.length > 0) {
      report += `Active vars (names only): ${injectedNames.join(", ")}\n`;
      report += "Source: top-level keys in auth.json using !pass read (or literals).\n";
      report += "These are injected via spawn hook — LLM never sees the values.\n";
    } else {
      report += "No shell env vars currently injected from auth.json.\n";
      report +=
        'Add e.g. "GH_TOKEN": "!pass read \'pass://Vault/Item/password\'" then /reload.\n';
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
      "Guided setup: pick a tool or enter a custom pass:// reference, write '!pass read …' to auth.json for transparent injection.",
    handler: async (_args, ctx) => {
      const authPath = getAuthFilePath();

      ctx.ui.notify("Proton Pass Onboard — transparent env injection setup", "info");

      const hasCurated = curatedTools.length > 0;
      const firstChoices = [
        hasCurated ? "Pick from a list of supported tools" : "",
        "Enter environment variable + secret reference manually",
        "Cancel",
      ].filter(Boolean);

      const mode = await selectInBorderedPopup(ctx, {
        title: "Proton Pass Onboard — How would you like to start?",
        items: firstChoices.map((c) => ({ value: c, label: c })),
        helpText: "↑↓ • Enter • Esc = cancel",
        maxVisible: 5,
      });
      if (!mode || mode === "Cancel") {
        ctx.ui.notify("Onboarding cancelled.", "info");
        return;
      }

      let finalEnv: string | null = null;
      let passRef: string | null = null;

      if (mode.startsWith("Pick from a list of supported tools")) {
        if (curatedTools.length === 0) {
          ctx.ui.notify("No curated tools available right now.", "warning");
          return;
        }

        const chosenToolName = await selectInBorderedPopup(ctx, {
          title: "Select tool (type to filter)",
          items: curatedTools.map((p) => ({
            value: p.name,
            label: p.name,
            description:
              p.envVars.length > 0
                ? `${p.primaryEnvVar ?? p.envVars[0] ?? ""} (+${String(p.envVars.length - 1)} more)`
                : "custom / no standard env var",
          })),
          helpText: "↑↓ • Enter • Esc = cancel • Type to filter",
          maxVisible: 16,
        });
        if (!chosenToolName) {
          ctx.ui.notify("Onboarding cancelled.", "info");
          return;
        }

        const tool = curatedTools.find((p) => p.name === chosenToolName);
        if (!tool) {
          ctx.ui.notify("Selected tool is no longer available.", "error");
          return;
        }

        if (tool.envVars.length > 1) {
          const chosenEnv = await selectInBorderedPopup(ctx, {
            title: `Environment variable for ${tool.name}`,
            items: tool.envVars.map((v) => ({
              value: v,
              label: v,
              description: v === tool.primaryEnvVar ? "primary / recommended" : undefined,
            })),
            helpText: "↑↓ • Enter to choose which var to inject • Esc = back",
            maxVisible: Math.min(12, tool.envVars.length + 2),
          });
          if (!chosenEnv) {
            ctx.ui.notify("Onboarding cancelled.", "info");
            return;
          }
          finalEnv = chosenEnv;
        } else {
          finalEnv = tool.primaryEnvVar ?? tool.envVars[0] ?? null;
        }

        if (!finalEnv) {
          ctx.ui.notify("Selected tool has no declared environment variable.", "error");
          return;
        }

        passRef = await pickPassReference(ctx);
        if (!passRef) {
          ctx.ui.notify("Onboarding cancelled.", "info");
          return;
        }
      } else {
        const envVar = await inputInBorderedPopup(ctx, {
          title: "Environment variable name",
          prompt: "Enter the UPPER_SNAKE_CASE name for the secret (e.g. GH_TOKEN)",
          helpText: "Enter to confirm • Esc = cancel",
        });
        if (!envVar) {
          ctx.ui.notify("Onboarding cancelled.", "info");
          return;
        }
        if (!/^[A-Z0-9_]+$/.test(envVar)) {
          ctx.ui.notify("Invalid env var name (must be UPPER_SNAKE_CASE).", "error");
          return;
        }
        finalEnv = envVar;

        const refMethod = await selectInBorderedPopup(ctx, {
          title: "How do you want to provide the secret location?",
          items: [
            { value: "manual", label: "Type the pass:// reference manually" },
            { value: "lookup", label: "Look it up in Proton Pass" },
          ],
          helpText: "↑↓ • Enter • Esc = cancel",
          maxVisible: 5,
        });
        if (!refMethod) {
          ctx.ui.notify("Onboarding cancelled.", "info");
          return;
        }

        if (refMethod === "manual") {
          const manualRef = await inputInBorderedPopup(ctx, {
            title: "pass:// Reference",
            prompt: "Enter the full Proton Pass reference",
            defaultValue: "pass://Vault/Item/field",
            helpText: "Must start with pass:// • Enter to confirm • Esc = cancel",
          });
          if (!manualRef?.startsWith("pass://")) {
            ctx.ui.notify("Invalid reference (must start with pass://) or cancelled.", "error");
            return;
          }
          passRef = manualRef;
        } else {
          passRef = await pickPassReference(ctx);
        }
        if (!passRef) {
          ctx.ui.notify("Onboarding cancelled.", "info");
          return;
        }
      }

      const previewLine = `"${finalEnv}": "!pass read '${passRef}'"`;
      const previewMsg =
        `File: ${authPath}\n\n${previewLine}\n\n` +
        "After write: run /reload (or restart). The spawn hook will inject the variable into bash.\n" +
        "Use /proton-pass_diagnose to verify (names only; values never leave the host).";

      const confirmed = await confirmInBorderedPopup(ctx, {
        title: "Add this to auth.json?",
        message: previewMsg,
      });
      if (!confirmed) {
        ctx.ui.notify("Cancelled — nothing written.", "info");
        return;
      }

      let writeRes = await addAuthEntry(finalEnv, passRef);

      if (!writeRes.success && writeRes.message.includes("already exists")) {
        const overwrite = await confirmInBorderedPopup(ctx, {
          title: `Key "${finalEnv}" already exists, overwrite?`,
          message: "Replace the current value in auth.json?",
        });
        if (overwrite) {
          writeRes = await addAuthEntry(finalEnv, passRef, { overwrite: true });
        } else {
          ctx.ui.notify(writeRes.message, "warning");
          return;
        }
      }

      if (writeRes.success) {
        ctx.ui.notify(`Success. ${finalEnv} added to auth.json (0600).`, "info");
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
