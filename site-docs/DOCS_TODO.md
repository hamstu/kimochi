# Docs TODOs for Hamish

Everything here needs a fact or a decision only Hamish has. Each content item is also marked in a
page with `<Todo>TODO(hamish): …</Todo>`, which shows as a dashed box in the dev server only
(`npm run docs:dev`), never in the build: `grep -rn "TODO(hamish)" site-docs/src`.

## Facts to confirm on a page

Added with the Language section (2026-11-12):

- **language/support: OCR coverage.** OneOCR is offered for every language, but its real coverage
  is unchecked; so is Screen AI's beyond the languages its model files name, and whether Google
  Lens uses the language Kimochi sends as a hint.
- **language/support: Apple Live Text.** The list is deliberately conservative (15 languages);
  macOS 26 also reports Turkish, Indonesian, Czech, Danish, Dutch, Norwegian, Polish, Romanian and
  Swedish. Which macOS release added each listed language is unverified. Mention it, or keep as is?
- **language/support: Kimochi cloud in other languages.** Cloud OCR, translation and Explain send
  the language to Kimochi's server, whose language support (server branch `feat/languages`) must be
  deployed first. Confirm it's live before publishing.
- **language/index: sample text.** The sample sentences and words for other languages (overlay
  preview, the Text Hooker card's example, the welcome guide's test lookup) were machine-written and
  not yet checked by native speakers. Say so on the page, or leave it out once checked?
- **language/japanese-only: known limits.** Text hooking still gives LunaHook code page 932
  (Shift-JIS) for non-Unicode hooks, and the browser extension lays text out as square Japanese
  glyphs. Worth stating to users, or fixed before release?

## Things the docs left out on purpose

- **Custom OCR endpoint.** The app can read one from its settings file, but there is no setting for
  it, so it is not a user-facing feature: the docs and the site don't mention it.
- **What's new.** No screenshot: the harness's sample release notes are invented and would read as
  real ones. The page text describes it instead.
- **Webhook input (port 7890)** and **presets**: present in code but not wired up, so not documented.
- **Logs and evidence files** (`evidence.jsonl`, `auto-ocr-trace.jsonl`): not documented file by
  file. Users reach the logs through **Settings → About → Debug info → Save debug bundle**, which
  Troubleshooting's "Still stuck?" walks through.
