# @flosrn/pi-proton-pass

Proton Pass credential injection for the [Pi](https://pi.dev) / OMP coding agent. Secrets stay in the vault; the model only sees command names.

## Install

```bash
# Pi
pi install npm:@flosrn/pi-proton-pass

# OMP
omp plugin install npm:@flosrn/pi-proton-pass
```

Needs [`pass-cli`](https://proton.me/pass) on PATH and a logged-in session (`pass-cli login`, then `pass-cli info`).

## Setup

```
/proton-pass_setup
```

Pick a tool (GH_TOKEN, AWS_…, …) or type an env var, then either browse the vault or paste a `pass://` reference. Confirm the line written to `auth.json` (mode 0600):

```json
{
  "GH_TOKEN": "!pass read 'pass://<share-id>/<item-id>/password'"
}
```

`/reload` (or restart) so bash picks it up. `/proton-pass_diagnose` lists **names** of injected vars, never values.

After that, `gh`, `aws`, and other CLIs run as-is inside the agent. The spawn hook injects the resolved env into the child process.

## Consumer API

Other extensions import this package instead of reading `auth.json`:

```ts
import { onboardSecret, resolveSecret } from "@flosrn/pi-proton-pass";

const key = await resolveSecret("context7");
if (!key) {
  await onboardSecret(ctx, { name: "context7", label: "Context7" });
}
```

`onboardSecret` opens the vault picker when `pass-cli` is logged in, or a masked paste field otherwise. `resolveSecret` / `verifySecret` / `deleteSecret` never return secrets through UI messages.

Manual references (OMP skill form) also resolve:

```
pass://Personal/GitHub Token/password
```

The picker stores the native id form (`pass://SHARE_ID/ITEM_ID/field`) so two items with the same title cannot shadow each other.

## Security

- Resolution runs in the host process via `pass-cli item view --field` (`execFile`, no shell).
- `PROTON_PASS_AGENT_REASON` is set on every vault call.
- Diagnose, tools, and onboarding messages never include secret values.
- Provider keys (`anthropic`, `openai`, `xai`, …) in `auth.json` are not injected into bash.

## Requirements

| | |
| --- | --- |
| Node | ≥ 22.19 |
| Pi / OMP | recent |
| pass-cli | logged in |

## License

MIT. Includes TUI helpers originally published in `@jmcombs/pi-1password` (Copyright 2025 Jeremy Combs).
