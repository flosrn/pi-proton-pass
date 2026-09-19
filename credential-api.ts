/**
 * Public credential surface. Other extensions import these instead of
 * touching Pi internals. Every call is stateless: fresh auth.json + pass-cli.
 *
 * Storage: `{ "context7": { "type": "api_key", "key": "!pass read 'pass://…'" } }`
 * or a legacy bare string. Never returns the secret from onboarding messages.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inputInBorderedPopup, selectInBorderedPopup } from "./ui/bordered-popups.js";
import { getPassStatus, pickPassReference } from "./pass.js";
import { capturePassItem } from "./capture.js";
import {
  deleteAuthEntry,
  PASS_READ_PREFIX,
  readAuthJson,
  resolveShellValue,
  writeProviderAuthEntry,
} from "./store.js";

export type UiContext = Pick<ExtensionContext, "ui">;

export interface OnboardOptions {
  readonly name: string;
  readonly label: string;
  readonly overwrite?: boolean;
}

export interface OnboardResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly resolved: boolean;
  readonly error?: string;
}

export interface DeleteResult {
  readonly ok: boolean;
}

export async function isProtonPassAvailable(): Promise<boolean> {
  const status = await getPassStatus();
  return status.available && status.configured;
}

export async function resolveSecret(name: string): Promise<string | undefined> {
  const parsed = await readAuthJson();
  const entry = parsed[name];
  let raw: unknown;
  if (typeof entry === "string") {
    raw = entry;
  } else if (entry && typeof entry === "object" && "key" in entry) {
    raw = entry.key;
  } else {
    raw = undefined;
  }
  const resolved = await resolveShellValue(raw);
  return resolved ?? undefined;
}

const CANCELLED: OnboardResult = { ok: false, message: "Onboarding cancelled." };

async function promptMaskedKey(ctx: UiContext, label: string): Promise<string | undefined> {
  return inputInBorderedPopup(ctx, {
    title: `Enter your ${label} API key`,
    helpText: "Enter to save • Esc = cancel",
    mask: true,
  });
}

/**
 * Take a brand-new secret and put it in the vault, returning only its reference.
 *
 * This is `agent/scripts/pass-secret.sh` without leaving the session: the value
 * is typed into a masked popup, crosses one pipe into `pass-cli`'s stdin, is
 * verified by fingerprint, and never reaches the transcript, an argv, or disk.
 * Prefer it over storing a literal in `auth.json` whenever a vault is reachable.
 */
export async function captureSecretIntoVault(
  ctx: UiContext,
  opts: { readonly label: string; readonly suggestedTitle: string; readonly defaultVault?: string },
): Promise<string | undefined> {
  const title = await inputInBorderedPopup(ctx, {
    title: "Name this item in Proton Pass",
    prompt:
      "Use a distinct title — date it if you expect to rotate.\n" +
      "An existing title is refused: Proton Pass would keep serving the older item.",
    defaultValue: opts.suggestedTitle,
    helpText: "Enter to confirm • Esc = cancel",
  });
  if (!title) return undefined;

  const vault = await inputInBorderedPopup(ctx, {
    title: "Which vault?",
    prompt: "Proton Pass vault that should hold the item.",
    defaultValue: opts.defaultVault ?? "Personal",
    helpText: "Enter to confirm • Esc = cancel",
  });
  if (!vault) return undefined;

  const secret = await promptMaskedKey(ctx, opts.label);
  if (!secret) return undefined;

  const result = await capturePassItem({ title, vault, secret });
  if (!result.ok) {
    ctx.ui.notify(result.message, "error");
    return undefined;
  }
  ctx.ui.notify(
    `Stored in Proton Pass as "${title}" and verified by fingerprint — the value was never printed.`,
    "info",
  );
  return result.ref;
}

async function saveAndReport(
  opts: OnboardOptions,
  storedValue: string,
  overwrite: boolean,
  kind: "ref" | "literal",
  passAvailable: boolean,
): Promise<OnboardResult> {
  const res = await writeProviderAuthEntry(opts.name, storedValue, { overwrite });
  if (!res.success) {
    return { ok: false, message: `Couldn't save your ${opts.label} key. Please try again.` };
  }

  const verified = await verifySecret(opts.name);
  if (kind === "ref") {
    if (verified.ok) {
      return {
        ok: true,
        message: `${opts.label} is set up. Your key stays in Proton Pass and unlocks on demand.`,
      };
    }
    return {
      ok: true,
      message: `Saved. Proton Pass couldn't read it yet — unlock the session, or check the reference.`,
    };
  }

  if (verified.ok) {
    return {
      ok: true,
      message: passAvailable
        ? `${opts.label} is set up. Your key is stored locally on this machine.`
        : `${opts.label} is set up, stored locally. Install pass-cli and log in to use your vault.`,
    };
  }
  return {
    ok: true,
    message: `Saved, but the key looks empty — re-run onboarding to fix it.`,
  };
}

export async function onboardSecret(ctx: UiContext, opts: OnboardOptions): Promise<OnboardResult> {
  let overwrite = opts.overwrite ?? false;

  if (!overwrite) {
    const parsed = await readAuthJson();
    if (parsed[opts.name] !== undefined) {
      const choice = await selectInBorderedPopup(ctx, {
        title: `${opts.label} is already set up`,
        items: [
          { value: "replace", label: "Replace it" },
          { value: "keep", label: "Keep the current key" },
        ],
        helpText: "↑↓ • Enter • Esc = keep current",
        maxVisible: 5,
      });
      if (choice !== "replace") {
        return { ok: false, message: `Kept your existing ${opts.label} key. Nothing changed.` };
      }
      overwrite = true;
    }
  }

  const passAvailable = await isProtonPassAvailable();

  if (passAvailable) {
    const source = await selectInBorderedPopup(ctx, {
      title: `Set up your ${opts.label} key`,
      items: [
        {
          value: "browse",
          label: "Locate in Proton Pass",
          description: "Browse your vaults and select item",
        },
        {
          value: "paste",
          label: "Type or paste the key now",
          description: "Masked input, stored in your vault — auth.json only gets the reference",
        },
        {
          value: "ref",
          label: "Enter a Proton Pass reference",
          description: "Advanced: a pass://vault/item/field path",
        },
        { value: "cancel", label: "Cancel" },
      ],
      helpText: "↑↓ • Enter • Esc = cancel",
      maxVisible: 6,
    });
    if (!source || source === "cancel") return CANCELLED;

    if (source === "browse") {
      const passRef = await pickPassReference(ctx);
      if (!passRef) return CANCELLED;
      return saveAndReport(opts, `${PASS_READ_PREFIX}'${passRef}'`, overwrite, "ref", true);
    }

    if (source === "paste") {
      // Deliberately NOT a literal in auth.json: with a vault reachable, a
      // plaintext copy on disk would be a silent downgrade of the same gesture.
      const captured = await captureSecretIntoVault(ctx, {
        label: opts.label,
        suggestedTitle: `${opts.label} (OMP)`,
      });
      if (!captured) return CANCELLED;
      return saveAndReport(opts, `${PASS_READ_PREFIX}'${captured}'`, overwrite, "ref", true);
    }

    const ref = await inputInBorderedPopup(ctx, {
      title: `Proton Pass reference for ${opts.label}`,
      prompt: "Enter the pass:// reference to your key's field.",
      defaultValue: "pass://Vault/Item/field",
      helpText: "Format pass://vault/item/field • Enter to confirm • Esc = cancel",
    });
    if (!ref) return CANCELLED;
    if (!/^pass:\/\/[^/]+\/.+\/[^/]+$/.test(ref)) {
      ctx.ui.notify("That doesn't look complete — use pass://vault/item/field.", "warning");
      return CANCELLED;
    }
    return saveAndReport(opts, `${PASS_READ_PREFIX}'${ref}'`, overwrite, "ref", true);
  }

  const key = await promptMaskedKey(ctx, opts.label);
  if (!key) return CANCELLED;
  return saveAndReport(opts, key, overwrite, "literal", false);
}

export async function changeSecret(ctx: UiContext, opts: OnboardOptions): Promise<OnboardResult> {
  return onboardSecret(ctx, { ...opts, overwrite: true });
}

export async function verifySecret(name: string): Promise<VerifyResult> {
  try {
    const resolved = await resolveSecret(name);
    if (typeof resolved === "string" && resolved.length > 0) {
      return { ok: true, resolved: true };
    }
    return {
      ok: false,
      resolved: false,
      error: `No value resolved for "${name}" (missing entry, or pass-cli failed / returned empty).`,
    };
  } catch (e) {
    return { ok: false, resolved: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteSecret(name: string): Promise<DeleteResult> {
  return deleteAuthEntry(name);
}
