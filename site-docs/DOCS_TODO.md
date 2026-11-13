# Docs TODOs for Hamish

Everything here needs a fact or a decision only Hamish has. Each content item is also marked in a
page with `<Todo>TODO(hamish): …</Todo>`, which shows as a dashed box in the dev server only
(`npm run docs:dev`), never in the build: `grep -rn "TODO(hamish)" site-docs/src`.

## Facts to confirm on a page

Added with the Language section (2026-11-12):

Nothing open. The Language section's questions were settled on 2026-11-12: OneOCR and Screen AI are
documented as reading every language, Apple Live Text's list ends "and many more", Kimochi cloud is
documented as if its language support were live (the server's `feat/languages` still has to be
deployed), and text hooking decodes in the language's code page (#157), so that limit is gone.

## Things the docs left out on purpose

- **Custom OCR endpoint.** The app can read one from its settings file, but there is no setting for
  it, so it is not a user-facing feature: the docs and the site don't mention it.
- **What's new.** No screenshot: the harness's sample release notes are invented and would read as
  real ones. The page text describes it instead.
- **Webhook input (port 7890)** and **presets**: present in code but not wired up, so not documented.
- **Logs and evidence files** (`evidence.jsonl`, `auto-ocr-trace.jsonl`): not documented file by
  file. Users reach the logs through **Settings → About → Debug info → Save debug bundle**, which
  Troubleshooting's "Still stuck?" walks through.
