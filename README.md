# Kimochi — Tauri migration experiment

A macOS Tauri version of Kimochi, built from the working Electron UI and the actual native-capture and Yomitan experiments. The Electron app and its profile remain separate.

## Location

This project now lives beside the Electron repository at `../kimochi-tauri`, outside its Git working tree. All existing files, uncommitted changes and build artifacts were moved intact. Historical reports retain their original paths. A standalone Git repository now contains baseline commit `c4724e7`, made before the Texthooker integration.

Build/runtime assets (`yomitan/`, macOS `bin/keytrigger-*`, and the tray icon in `resources/`) are local copies from Kimochi. Two parity tests still read `../kimochi/src/main/` to compare against the Electron implementation; keep that sibling checkout available when running the full test suite.

## Install, build and run

```sh
cd ~/dev/japanese/kimochi-tauri
npm install
npm test
npm run typecheck
npm run lint
npm run check:rust
npm run bundle
npm start
```

`npm run release` builds the optimised, signed app at `src-tauri/target/release/bundle/macos/Kimochi.app` (install by copying it to `/Applications`). `npm run preview:ui` renders every window in Chrome against mocked native commands for design work.

Requires macOS 14+, Node/npm, Rust and Command Line Tools. `npm start` (also `npm run dev`) opens the **already-built** `src-tauri/target/debug/bundle/macos/Kimochi.app`; rebuild after changes. Always launch the bundle: a bare executable can have a different WebKit IndexedDB identity and appear to lose dictionaries.

The runner sets `DEVELOPER_DIR=/Library/Developer/CommandLineTools` for this host. It uses an installed Apple Development signing identity when available, or `APPLE_SIGNING_IDENTITY`. `KIMOCHI_ADHOC=1` opts out. This is a local development bundle, not a notarized release; no signing keys are stored here.

## Integrated Texthooker

The **Log** window now hosts Super Texthooker: sessions, transcript actions, reading statistics, notebooks and dictionary lookups. Settings → **Texthooker** contains OCR/Clipboard/WebSocket input cards, optional OCR outputs and reading tools. **Notebook** opens characters, places, notes and VNDB import in its own window. Main settings use a sidebar; all panel title bars share compact chrome. Window captures can resume a matching session; manually choosing or creating a session overrides the association. Display captures keep the manually selected session.

See [TEXTHOOKER_INTEGRATION.md](TEXTHOOKER_INTEGRATION.md) for architecture, reused code, validation and the short integration checklist.

## Main workflow

- **Controller → Source:** a separate native popover lists screens first, then app windows with local thumbnails and icons. Select one to fill the preview area, drag an optional crop, then Continue. Changes apply only on save.
- **Select Region:** screen sources use desktop region selection followed by an immediate scan; window sources edit their crop in the picker.
- **Scan / automatic OCR:** use the existing Kimochi cloud service or local server, with optional change detection, local OCR gating and adaptive polling. Settings also exposes local Tesseract and OwOCR modes. Tesseract downloads Japanese language data on first use; OwOCR requires its separate WebSocket service.
- **Settings:** OCR, Shortcuts, Gamepad, Dictionary, Audio and Texthooker retain the Electron controls. Source selection has moved out of Settings.
- **Log:** scan history, font size, opacity, selection, dictionary lookup, per-entry audio/delete and clear-all. Controller, Log, Settings and diagnostic views are independent native windows with the original title bars and controls.
- **Dictionary:** Open Yomitan Settings reaches the original extension settings/import UI. Import your dictionaries there; dictionary contents live in IndexedDB. The extension compatibility adapter is not native browser-extension support.

Source previews stay local. A cloud/server OCR scan sends the selected capture or crop to that service. Local Tesseract processes pixels in the app. No user screenshots are written to this experiment's reports.

## macOS access

Screen capture requires this app's own Screen Recording grant. If the app is absent from System Settings → Privacy & Security → Screen & System Audio Recording, use **+** and select the bundle above (⌘⇧G opens a path field). Enable it and relaunch. A stale entry from an earlier ad-hoc bundle may need to be removed and added again. The app includes access-request and settings links; another experiment's grant does not apply here.

Keyboard-triggered automatic scans use the existing keytrigger helper and may require Accessibility access. Ordinary global shortcuts and gamepad controls have separate native implementations. The UI reports unavailable access and shortcut registration failures.

## Architecture and reused code

| Layer | Implementation |
| --- | --- |
| Native app | `src-tauri/`: windows, settings, source catalog, capture, OCR HTTP, input, tray, clipboard and texthooker WebSocket server. |
| Capture | `capture-core/`: isolated copy of the proven ScreenCaptureKit module. The integration adds exclusion of this process's windows from display captures; the original experiment is unchanged. See its README and `evidence/capture-core-migration.json`. |
| Panels | `frontend/`: copied Electron React components/styles with provenance headers and a typed Tauri bridge. One panel entry dispatches on native window label. |
| Source picker | `frontend/source-picker/`: lazy bounded thumbnail requests, full local preview, draft crop and atomic source/crop commit. |
| OCR and overlay | `ui/`: always-present overlay WebView hosts the scanner, change detection, OCR backends, annotation mapping/rendering and output. Rust supplies explicit interactive hit regions; interaction does not depend on pixel alpha. |
| Dictionary | `host/`: compatibility host reused from the Yomitan spike, extended for native panel communication. `yomitan/` is copied without changing distributed extension files; `npm run verify` checks all 421 hashes. |

Geometry uses desktop points and the **current full capture dimensions**, with crop origin and saved reference dimensions kept separate. Each axis scales independently; the Controller WebView's DPR is never the capture scale. Full previews and the latest frame are held in bounded native memory and served through the local `capture:` protocol.

Settings/history/window state live under `~/Library/Application Support/dev.kimochi.app/`. Kimochi settings are in `settings.json`, extension preferences in `chrome-local.json`, and dictionaries in WebKit IndexedDB. The app is intended to run as one instance.

## Validation and remaining work

The migration's final checks and limitations are recorded in [MIGRATION.md](MIGRATION.md). [PARITY_GAPS.md](PARITY_GAPS.md) tracks differences from Electron; [COMMANDS.md](COMMANDS.md) documents the native interface. [RESULTS.md](RESULTS.md) contains **historical POC evidence**, not validation of the larger migration.

Per the requested workflow, migration validation is limited to static checks, focused regression tests and a launch smoke test. Native interaction, actual OCR, dictionary import/lookup and cross-monitor behavior in this migrated version require your testing: [MANUAL_TESTING.md](MANUAL_TESTING.md).

macOS is the implementation target. Windows/Linux capture and input are not implemented or proven. One overlay covers the selected source's center display; sources spanning display boundaries, fullscreen/Spaces behavior and long-running use need further work/testing. Tauri transparency uses its macOS private API feature. The trusted bundled extension host retains the spike's unsupported-API and memory caveats. No capture speedup over Electron is claimed.

### Automatic OCR

Automatic scanning now reads the screen locally before spending a remote request:
[AUTO_OCR.md](AUTO_OCR.md) documents the architecture, the Apple Live Text private-API
adapter and its costs, the Windows gap, the tuning defaults and a user integration
checklist. Research behind the design is in
[GSM_AUTO_OCR_RESEARCH.md](GSM_AUTO_OCR_RESEARCH.md); measured evidence is in
[evidence/auto-ocr.json](evidence/auto-ocr.json).

The previous two-gate loop hashed the whole crop inside the WebView, and a hash failure
fell through to the expensive call — so a broken gate meant a remote OCR request on
every tick. The recorded `Load failed` errors were never traced to a specific step, so
that dependency is removed rather than repaired: the hash and the local text reading are
both computed natively from the captured pixels and arrive with the capture itself.
Automatic mode reports itself unavailable on a platform with no local observer instead
of uploading every frame; **Windows has no observer yet**.

### Latest debugging pass

[Scanning without taking focus](evidence/focus-without-taking-it.md) records the most
recent pass: a lookup no longer needs the overlay to hold the keyboard, so nothing
activates this app to make one happen, and the overlay and the dictionary are
non-activating panels — clicking either leaves the reader's own window order alone.

[Overlay enable, proximity and window focus](evidence/overlay-enable-proximity-and-window-focus.md)
records the three fixes before it: switching the overlay's text on now scans rather
than switching on to nothing, the proximity effect follows the pointer from the native
cursor poll instead of waiting for the overlay to have focus, and scanned text and its
click targets are hidden when the captured **window** — not merely its application —
stops being the one in front.

[Gray window and source-picker fixes](evidence/gray-window-and-picker.md) records the subsequent native runtime checks. The picker now lists window-server metadata before fetching icons/thumbnails; hidden, untitled, tiny and nonstandard helper surfaces are excluded.

### Automatic OCR responsiveness tuning

See [AUTO_OCR_TUNING.md](AUTO_OCR_TUNING.md) for the native timing measurements, live static-window app check, calibrated replay scenarios and remaining limitations. Existing default scan intervals migrate to faster local observation; cloud requests stay separately limited. Disappearing text now clears annotations without waiting for the cloud.

### Capture reliability investigation

See [CAPTURE_RELIABILITY.md](CAPTURE_RELIABILITY.md) for frame ownership and live-preview fixes, background scheduling, measured crop costs, runtime evidence and remaining limits.

### Gameplay diagnostic logging

Auto OCR now records a bounded, content-free change/timing timeline automatically. See [AUTO_OCR_DIAGNOSTICS.md](AUTO_OCR_DIAGNOSTICS.md) for the test-run steps, optional timestamp markers and `npm run trace:summary`.
