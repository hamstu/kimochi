# Docs TODOs for Hamish

Everything here needs a fact or a decision only Hamish has. Each content item is also marked in a
page with `<Todo>TODO(hamish): …</Todo>`, which shows as a dashed box in the dev server only
(`npm run docs:dev`), never in the build: `grep -rn "TODO(hamish)" site-docs/src`.

## Facts to confirm on a page

1. **Intel Macs** (install/macos): CI builds Apple silicon only. Say "not supported", or is an Intel
   build planned? (Same as site/SEO_TODO.md #5.)
2. **Uninstalling on macOS** (install/macos): nothing in the repo documents it. Is "move to the Bin,
   delete `~/Library/Application Support/dev.kimochi.app/`" complete, or is there a WebKit storage
   folder (the dictionaries' IndexedDB) to remove too? (Also reference/data.)
3. **Windows: SmartScreen and minimum version** (install/windows): does the Azure-signed installer
   still warn on first run? Is Windows 10 22H2 the real minimum (it comes from the README's build
   prerequisites)?
4. **Windows data folders** (install/windows, reference/data): where they are, and whether the
   uninstaller removes them.
5. **Overlay on Wayland** (install/linux): which desktops show it today (KDE Plasma, Hyprland, Sway…)?
   And which distributions should the docs call tested? (SEO_TODO #5.)
6. **Hyprland shortcuts** (install/linux): the exact config lines for Scan and Controller menu.
9. **Yomitan API lookups in the Log** (lookups/dictionaries): its description says "Click words in
   the Log to look them up". A click, or Shift-hover?
10. **Tested texthookers** (reading/texthookers): Textractor (with a WebSocket plugin), LunaTranslator,
    Agent, owocr…: which have you tried, and with what settings? (SEO_TODO #8.)
11. **Tested controllers** (controller): Settings warns gamepad support may be unverified on a
    platform. Which pads and platforms are known to work?
12. **Kimochi Cloud** (cloud): currency (USD?), free monthly allowances (privacy says yes, pricing
    shows only the trial), and whether Sync needs Kimochi Cloud (the app says so; the privacy page
    and FAQ say signing in syncs). (SEO_TODO #3, #4.)

## Things the docs left out on purpose

- **Custom OCR endpoint.** The FAQ (`engines-and-dictionaries`) and the privacy page mention "your own
  custom OCR endpoint" / "own OCR server", but the app's engine list (`OcrMode` in `ui/settings.ts`)
  has no such engine. The docs don't mention it; fix the FAQ and privacy page or tell me where it is.
- **The tray popover** (left-click on the tray icon). The main checkout has uncommitted work removing
  it (`frontend/panels/TrayPopover.tsx` deleted), so the docs only mention the tray menu's
  Show Kimochi / Mini mode / Settings / Quit. Check `reading/mini-mode` and `reference/settings` once
  that lands.
- **What's new.** No screenshot: the harness's sample release notes are invented and would read as
  real ones. The page text describes it instead.
- **Webhook input (port 7890)** and **presets**: present in code but not wired up, so not documented.
- **Logs and evidence files** (`evidence.jsonl`, `auto-ocr-trace.jsonl`): not surfaced in the app,
  so not documented for users. Say if you'd like a "send me your logs" section in Troubleshooting.

## Before going live

14. **The GitHub repo is private**: every "GitHub", "Releases" and "issue" link in the docs 404s for
    the public until it is public (same as SEO_TODO #1).
15. **Deploy and DNS** (see README.md, "Deploying"): approve creating the `kimochi-docs` Worker and the
    `docs.kimochiapp.com` custom domain.
16. **Search engines**: once live, submit `https://docs.kimochiapp.com/sitemap-index.xml` in Search
    Console alongside the marketing site's sitemap.
