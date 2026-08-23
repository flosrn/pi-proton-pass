/**
 * Stateless auth.json access + bang-command secret resolver.
 *
 * Storage shapes:
 *   { "GH_TOKEN": "!pass read 'pass://Personal/GitHub/password'" }
 *   { "context7": { "type": "api_key", "key": "!pass read 'pass://…'" } }
 *
 * `!pass read` is resolved in this host process via `pass-cli item view --field`.
 * Other `!<cmd>` values run in /bin/sh (test sentinels: `!echo`, `!exit 1`).
 * Fail closed: any error → null / no write of the unresolved raw value.
 */

import { open, mkdir, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export const PASS_READ_PREFIX = "!pass read ";

export interface ProviderWriteResult {
  readonly success: boolean;
  readonly message: string;
  readonly alreadyExists?: boolean;
}

function agentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && override.length > 0) return override;
  return getAgentDir();
}

export function getAuthFilePath(): string {
  return join(agentDir(), "auth.json");
}

export async function readAuthJson(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(getAuthFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or invalid → empty store.
  }
  return {};
}

async function acquireAuthLock(lockPath: string): Promise<() => Promise<void>> {
  const timeoutMs = 5000;
  const start = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return async (): Promise<void> => {
        try {
          await unlink(lockPath);
        } catch {
          // Already gone.
        }
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      if (Date.now() - start > timeoutMs) {
        try {
          await unlink(lockPath);
        } catch {
          // Someone else cleared it.
        }
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 25 + Math.floor(Math.random() * 25));
      await promise;
    }
  }
}

async function mutateAuthFileLocked(
  mutator: (current: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<{ changed: boolean }> {
  const dir = agentDir();
  const authPath = join(dir, "auth.json");
  const lockPath = `${authPath}.lock`;

  await mkdir(dir, { recursive: true });
  const release = await acquireAuthLock(lockPath);
  try {
    let current: Record<string, unknown> = {};
    try {
      const raw = await readFile(authPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Start fresh.
    }

    const next = mutator(current);
    if (next === null) return { changed: false };

    const content = `${JSON.stringify(next, null, 2)}\n`;
    const tmpPath = `${authPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, authPath);
      await chmod(authPath, 0o600);
    } catch (e) {
      try {
        await unlink(tmpPath);
      } catch {
        // Temp may not exist.
      }
      throw e;
    }
    return { changed: true };
  } finally {
    await release();
  }
}

export async function writeProviderAuthEntry(
  name: string,
  key: string,
  options: { overwrite?: boolean } = {},
): Promise<ProviderWriteResult> {
  let alreadyExists = false;
  const { changed } = await mutateAuthFileLocked((current) => {
    alreadyExists = Object.hasOwn(current, name);
    if (alreadyExists && !options.overwrite) return null;
    return { ...current, [name]: { type: "api_key", key } };
  });
  if (!changed) {
    return {
      success: false,
      alreadyExists: true,
      message: `Key "${name}" already exists in auth.json. Use changeSecret (overwrite) or remove it first.`,
    };
  }
  return { success: true, message: "Entry saved." };
}

export async function addAuthEntry(
  envVar: string,
  passRef: string,
  options: { overwrite?: boolean } = {},
): Promise<{ success: boolean; message: string; path: string }> {
  const authPath = getAuthFilePath();
  let alreadyExists = false;
  const { changed } = await mutateAuthFileLocked((current) => {
    alreadyExists = Object.hasOwn(current, envVar);
    if (alreadyExists && !options.overwrite) return null;
    return { ...current, [envVar]: `${PASS_READ_PREFIX}'${passRef}'` };
  });
  if (!changed) {
    return {
      success: false,
      message: `Key "${envVar}" already exists in auth.json. Pick a different env var name or remove the old entry first.`,
      path: authPath,
    };
  }
  return { success: true, message: "Entry added.", path: authPath };
}

export async function deleteAuthEntry(name: string): Promise<{ ok: boolean }> {
  let existed = false;
  await mutateAuthFileLocked((current) => {
    if (!Object.hasOwn(current, name)) {
      existed = false;
      return null;
    }
    existed = true;
    const next = { ...current };
    delete next[name];
    return next;
  });
  return { ok: existed };
}

export function parsePassReadRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(PASS_READ_PREFIX)) return null;
  return trimmed.replace(/^!pass read\s+/, "").replace(/^['"]|['"]$/g, "") || null;
}

export function findFirstPassRef(parsed: Record<string, unknown>): string | null {
  for (const value of Object.values(parsed)) {
    let candidate: unknown;
    if (typeof value === "string") {
      candidate = value;
    } else if (value && typeof value === "object" && !Array.isArray(value) && "key" in value) {
      candidate = value.key;
    } else {
      candidate = undefined;
    }
    if (typeof candidate === "string" && candidate.trim().startsWith(PASS_READ_PREFIX)) {
      return candidate.trim();
    }
  }
  return null;
}

/** Proton Pass share/item ids are long base64url; vault names are not. */
function looksLikePassId(segment: string): boolean {
  return segment.length >= 40 && /^[A-Za-z0-9_-]+={0,2}$/.test(segment);
}

/**
 * Native CLI: `pass://SHARE_ID/ITEM_ID/field`.
 * Manual / OMP skill: `pass://Vault/Title/field` (title may contain slashes).
 */
export function parsePassUri(ref: string):
  | { kind: "id"; shareId: string; itemId: string; field: string }
  | { kind: "name"; vault: string; title: string; field: string }
  | null {
  if (!ref.startsWith("pass://")) return null;
  const body = ref.slice("pass://".length);
  const parts = body.split("/");
  if (parts.length >= 3 && looksLikePassId(parts[0] ?? "") && looksLikePassId(parts[1] ?? "")) {
    const shareId = parts[0];
    const itemId = parts[1];
    const field = parts.slice(2).join("/");
    if (!shareId || !itemId || !field) return null;
    return { kind: "id", shareId, itemId, field };
  }
  if (parts.length < 3) return null;
  const vault = parts[0];
  const field = parts[parts.length - 1];
  const title = parts.slice(1, -1).join("/");
  if (!vault || !title || !field) return null;
  return { kind: "name", vault, title, field };
}

async function resolvePassRead(ref: string): Promise<string | null> {
  const parsed = parsePassUri(ref);
  if (!parsed) return null;
  const args =
    parsed.kind === "id"
      ? ["item", "view", `pass://${parsed.shareId}/${parsed.itemId}/${parsed.field}`]
      : [
          "item",
          "view",
          "--vault-name",
          parsed.vault,
          "--item-title",
          parsed.title,
          "--field",
          parsed.field,
        ];
  try {
    const { stdout } = await execFileAsync("pass-cli", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 15000,
      env: {
        ...process.env,
        PROTON_PASS_AGENT_REASON: "pi-proton-pass: resolve stored reference",
      },
    });
    const value = (stdout || "").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function resolveShellValue(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();

  if (trimmed.startsWith(PASS_READ_PREFIX)) {
    const ref = parsePassReadRef(trimmed);
    if (!ref) return null;
    return resolvePassRead(ref);
  }

  if (trimmed.startsWith("!")) {
    try {
      const cmd = trimmed.slice(1).trim();
      const { stdout } = await execAsync(cmd, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 15000,
        shell: "/bin/sh",
      });
      return (stdout || "").trim();
    } catch {
      return null;
    }
  }

  return trimmed || null;
}
