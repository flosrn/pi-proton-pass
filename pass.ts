/**
 * pass-cli probes and the vault → item → field picker.
 * Values from `item view` stay in this process; only field *names* reach the UI.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { selectInBorderedPopup } from "./ui/bordered-popups.js";
import type { UiContext } from "./credential-api.js";

const execFileAsync = promisify(execFile);

export interface PassStatus {
  available: boolean;
  version: string | null;
  signedIn: boolean;
  configured: boolean;
  account: { username?: string; email?: string } | null;
}

export interface CuratedTool {
  name: string;
  slug: string;
  envVars: string[];
  primaryEnvVar: string | null;
}

async function passCli(
  args: string[],
  opts: { timeout?: number; reason?: string; maxBuffer?: number } = {},
): Promise<string> {
  const env = { ...process.env };
  if (opts.reason) env.PROTON_PASS_AGENT_REASON = opts.reason;
  const { stdout } = await execFileAsync("pass-cli", args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 15000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    env,
  });
  return stdout ?? "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function getPassStatus(): Promise<PassStatus> {
  let version: string | null = null;
  try {
    const stdout = await passCli(["-V"], { timeout: 5000 });
    version = stdout.trim() || "ok";
  } catch {
    return { available: false, version: null, signedIn: false, configured: false, account: null };
  }

  try {
    const stdout = await passCli(["info"], { timeout: 8000 });
    const username = stdout.match(/Username:\s*(.+)/)?.[1]?.trim();
    const email = stdout.match(/Email:\s*(.+)/)?.[1]?.trim();
    return {
      available: true,
      version,
      signedIn: true,
      configured: true,
      account: username || email ? { username, email } : {},
    };
  } catch {
    return {
      available: true,
      version,
      signedIn: false,
      configured: false,
      account: null,
    };
  }
}

export function formatPassStatus(status: PassStatus): string {
  if (!status.available) {
    return "Proton Pass CLI (`pass-cli`) is not available in PATH.";
  }
  if (!status.configured) {
    return `pass-cli ${status.version ?? "unknown"} is installed but no session is active. Run \`pass-cli login\`.`;
  }
  const who = status.account?.email ?? status.account?.username;
  if (status.signedIn && who) {
    return `pass-cli ${status.version ?? "unknown"} — signed in as ${who}`;
  }
  return `pass-cli ${status.version ?? "unknown"} — session configured.`;
}

interface PassVault {
  name: string;
  share_id: string;
}

interface PassItem {
  id: string;
  share_id: string;
  title: string;
  item_type?: string;
}

function parseVaults(raw: unknown): PassVault[] {
  const root = asRecord(raw);
  const list = root && Array.isArray(root.vaults) ? root.vaults : Array.isArray(raw) ? raw : [];
  const out: PassVault[] = [];
  for (const entry of list) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const name = stringField(rec, "name");
    const share_id = stringField(rec, "share_id") ?? "";
    if (name) out.push({ name, share_id });
  }
  return out;
}

function parseItems(raw: unknown): PassItem[] {
  const root = asRecord(raw);
  const list = root && Array.isArray(root.items) ? root.items : Array.isArray(raw) ? raw : [];
  const out: PassItem[] = [];
  for (const entry of list) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const id = stringField(rec, "id");
    const title = stringField(rec, "title");
    const share_id = stringField(rec, "share_id") ?? "";
    if (id && title) {
      out.push({
        id,
        share_id,
        title,
        item_type: stringField(rec, "item_type"),
      });
    }
  }
  return out;
}

function fieldNamesFromView(raw: unknown): { label: string; type?: string }[] {
  const root = asRecord(raw);
  const item = root ? asRecord(root.item) ?? root : null;
  if (!item) return [];
  const wrapper = asRecord(item.content);
  if (!wrapper) return [];

  const fields: { label: string; type?: string }[] = [];
  const typed = asRecord(wrapper.content);
  if (typed) {
    for (const [typeName, body] of Object.entries(typed)) {
      const rec = asRecord(body);
      if (!rec) continue;
      for (const key of Object.keys(rec)) {
        if (key === "passkeys" || key === "urls") continue;
        fields.push({ label: key, type: typeName });
      }
    }
  }

  const extra = wrapper.extra_fields;
  if (Array.isArray(extra)) {
    for (const entry of extra) {
      const rec = asRecord(entry);
      if (!rec) continue;
      const name =
        stringField(rec, "field_name") ?? stringField(rec, "name") ?? stringField(rec, "label");
      if (name) fields.push({ label: name, type: "extra" });
    }
  }
  return fields;
}

function isCredentialField(field: { label: string; type?: string }): boolean {
  const label = field.label.toLowerCase();
  return /password|credential|api[\s_-]?key|secret|token|totp/.test(label);
}

/**
 * Interactive vault → item → field picker.
 * Returns a name-based `pass://Vault/Title/field` reference, or null on cancel.
 */
export async function pickPassReference(ctx: UiContext): Promise<string | null> {
  const browseHelp = "↑↓ • Enter • Esc = cancel • Type to filter";

  ctx.ui.setStatus("pp-onboard", "Loading vaults...");
  let vaults: PassVault[] = [];
  try {
    const stdout = await passCli(["vault", "list", "--output", "json"], {
      timeout: 20000,
      reason: "pi-proton-pass: list vaults for setup picker",
    });
    vaults = parseVaults(JSON.parse(stdout || "{}"));
    vaults.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    ctx.ui.notify("Couldn't reach Proton Pass — run `pass-cli login`.", "warning");
    ctx.ui.setStatus("pp-onboard", undefined);
    return null;
  }
  ctx.ui.setStatus("pp-onboard", undefined);

  if (vaults.length === 0) {
    ctx.ui.notify("No vaults found in your Proton Pass account.", "warning");
    return null;
  }

  const chosenVault = await selectInBorderedPopup(ctx, {
    title: "Choose a vault",
    items: [
      ...vaults.map((v) => ({ value: v.name, label: v.name })),
      { value: "__cancel", label: "Cancel" },
    ],
    helpText: browseHelp,
    maxVisible: 14,
  });
  if (!chosenVault || chosenVault === "__cancel") return null;

  ctx.ui.setStatus("pp-onboard", `Loading items from ${chosenVault}...`);
  let items: PassItem[] = [];
  try {
    const stdout = await passCli(
      ["item", "list", chosenVault, "--output", "json", "--filter-state", "active"],
      {
        timeout: 25000,
        maxBuffer: 8 * 1024 * 1024,
        reason: "pi-proton-pass: list items for setup picker",
      },
    );
    items = parseItems(JSON.parse(stdout || "{}"));
    items.sort((a, b) => a.title.localeCompare(b.title));
  } catch {
    ctx.ui.notify(`Couldn't load items from "${chosenVault}". Try again.`, "warning");
    ctx.ui.setStatus("pp-onboard", undefined);
    return null;
  }
  ctx.ui.setStatus("pp-onboard", undefined);

  if (items.length === 0) {
    ctx.ui.notify(`No items found in "${chosenVault}".`, "warning");
    return null;
  }

  const chosenItemId = await selectInBorderedPopup(ctx, {
    title: `Choose an item in ${chosenVault}`,
    items: [
      ...items.map((it) => ({
        value: it.id,
        label: `${it.title}${it.item_type ? ` — ${it.item_type}` : ""}`,
      })),
      { value: "__cancel", label: "Cancel" },
    ],
    helpText: browseHelp,
    maxVisible: 16,
  });
  if (!chosenItemId || chosenItemId === "__cancel") return null;

  const chosenItem = items.find((it) => it.id === chosenItemId);
  if (!chosenItem) return null;

  ctx.ui.setStatus("pp-onboard", "Loading fields...");
  let fields: { label: string; type?: string }[] = [];
  try {
    const stdout = await passCli(
      ["item", "view", "--item-id", chosenItem.id, "--output", "json"],
      { timeout: 15000, reason: "pi-proton-pass: list field names for setup picker" },
    );
    fields = fieldNamesFromView(JSON.parse(stdout || "null"));
  } catch {
    ctx.ui.notify("Couldn't load that item's fields. Try again.", "warning");
    ctx.ui.setStatus("pp-onboard", undefined);
    return null;
  }
  ctx.ui.setStatus("pp-onboard", undefined);

  if (fields.length === 0) {
    ctx.ui.notify("That item has no fields to use.", "warning");
    return null;
  }

  const credentialFields = fields.filter(isCredentialField);
  let chosenField: string | null;
  if (credentialFields.length === 1) {
    chosenField = credentialFields[0]?.label ?? null;
  } else {
    chosenField = await selectInBorderedPopup(ctx, {
      title: "Which field holds the key?",
      items: [
        ...fields.map((f) => ({
          value: f.label,
          label: `${f.label}${f.type ? ` (${f.type})` : ""}`,
        })),
        { value: "__cancel", label: "Cancel" },
      ],
      helpText: browseHelp,
      maxVisible: 12,
    });
    if (!chosenField || chosenField === "__cancel") return null;
  }
  if (!chosenField) return null;

  if (!chosenItem.share_id) {
    ctx.ui.notify("That item has no share id — cannot store a stable reference.", "warning");
    return null;
  }
  return `pass://${chosenItem.share_id}/${chosenItem.id}/${chosenField}`;
}

export async function loadCuratedTools(): Promise<CuratedTool[]> {
  try {
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { readFile } = await import("node:fs/promises");
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, "data", "tools.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: CuratedTool[] = [];
    for (const entry of parsed) {
      const rec = asRecord(entry);
      if (!rec) continue;
      const name = stringField(rec, "name");
      const slug = stringField(rec, "slug");
      if (!name || !slug) continue;
      const envVars = Array.isArray(rec.envVars)
        ? rec.envVars.filter((v): v is string => typeof v === "string")
        : [];
      const primary = rec.primaryEnvVar;
      out.push({
        name,
        slug,
        envVars,
        primaryEnvVar: typeof primary === "string" ? primary : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}
