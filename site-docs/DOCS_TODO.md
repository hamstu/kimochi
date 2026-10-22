# Docs TODOs for Hamish

Everything here needs a fact or a decision only Hamish has. Each content item is also marked in a
page with `<Todo>TODO(hamish): …</Todo>`, which shows as a dashed box in the dev server only
(`npm run docs:dev`), never in the build: `grep -rn "TODO(hamish)" site-docs/src`.

## Facts to confirm on a page

Nothing open. All questions were answered on 2026-10-22.

## Things the docs left out on purpose

- **Custom OCR endpoint.** The app can read one from its settings file, but there is no setting for
  it, so it is not a user-facing feature: the docs and the site don't mention it.
- **The tray popover** (left-click on the tray icon). The main checkout has uncommitted work removing
  it (`frontend/panels/TrayPopover.tsx` deleted), so the docs only mention the tray menu's
  Show Kimochi / Mini mode / Settings / Quit. Check `reading/mini-mode` and `reference/settings` once
  that lands.
- **What's new.** No screenshot: the harness's sample release notes are invented and would read as
  real ones. The page text describes it instead.
- **Webhook input (port 7890)** and **presets**: present in code but not wired up, so not documented.
- **Logs and evidence files** (`evidence.jsonl`, `auto-ocr-trace.jsonl`): not surfaced in the app,
  so not documented for users. Say if you'd like a "send me your logs" section in Troubleshooting.
