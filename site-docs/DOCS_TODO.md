# Docs TODOs for Hamish

Everything here needs a fact or a decision only Hamish has. Each content item is also marked in a
page with `<Todo>TODO(hamish): …</Todo>`, which shows as a dashed box in the dev server only
(`npm run docs:dev`), never in the build: `grep -rn "TODO(hamish)" site-docs/src`.

## Facts to confirm on a page

Nothing open. All questions were answered on 2026-10-22.

## Screenshots the pipeline can't draw yet

The preview harness has no overlay, so these are described in text with a "Screenshot to come"
note on the page:

- **The Text Hooker's card over a game** (`reading/text-hooker`), ideally with Auto align on and the
  card's −, + and ⋯ controls showing.
- **The overlay's hint bar** ("Hold Shift to look up words and click text", `reading/overlay`).
- **The sidebar's Auto align switch** under Show overlay for a hooked game: the harness's `hook-card`
  shot has the overlay off, so the switch isn't in it.

## Things the docs left out on purpose

- **Custom OCR endpoint.** The app can read one from its settings file, but there is no setting for
  it, so it is not a user-facing feature: the docs and the site don't mention it.
- **What's new.** No screenshot: the harness's sample release notes are invented and would read as
  real ones. The page text describes it instead.
- **Webhook input (port 7890)** and **presets**: present in code but not wired up, so not documented.
- **Logs and evidence files** (`evidence.jsonl`, `auto-ocr-trace.jsonl`): not documented file by
  file. Users reach the logs through **Settings → About → Debug info → Save debug bundle**, which
  Troubleshooting's "Still stuck?" walks through.
