# Changelog

## 1.0.0 — 2026-08-24

- `/proton-pass_setup` and `/proton-pass_diagnose`
- `pp_diagnose` tool (names only)
- Stateless credential API: `onboardSecret`, `resolveSecret`, `verifySecret`, `deleteSecret`
- Transparent bash env injection via `createBashTool` spawnHook
- `!pass read 'pass://…'` stored in auth.json; picker writes native `SHARE_ID/ITEM_ID` URIs
