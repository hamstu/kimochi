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

The two OCR crates are path dependencies: `kimochi-meikiocr` and `kimochi-mangaocr` must be checked out beside this repository (`../kimochi-meikiocr`, `../kimochi-mangaocr`). Two parity tests also read the Electron app at `../kimochi`; without it they are reported as skipped.

On macOS, Apple Live Text is offered as a local engine with nothing to download: it is the system's own text recognition, reached through the same private VisionKitCore path automatic scanning uses (see [OCR.md](OCR.md) and [AUTO_OCR.md](AUTO_OCR.md)).

Windows builds also bundle the small local OneOCR helpers from `oneocr-worker/`. Install both Rust targets (`rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc`) and the MSVC v143 ARM64/ARM64EC C++ build tools component (`Microsoft.VisualStudio.Component.VC.Tools.ARM64`) alongside the x64 C++ workload. OneOCR uses the installed Snipping Tool runtime on Windows 11; Windows 10 users can supply its three runtime files. See [ONEOCR.md](ONEOCR.md) for setup and [WINDOWS_ONEOCR.md](WINDOWS_ONEOCR.md) for validation.

| Command | What it does |
| --- | --- |
| `npm run bundle` | Debug bundle for this OS: `.app` (macOS), NSIS `-setup.exe` (Windows), `.deb` + `.AppImage` (Linux), under `src-tauri/target/debug/bundle/`. Stages the OCR runtime and licences first; the OCR models are downloaded by the app on demand, not bundled. |
| `npm run release` | Optimised bundle for this OS, under `src-tauri/target/release/bundle/`. |
| `npm start` | Launches the **already-built** debug output: `open`s `Kimochi.app` on macOS, starts `target/debug/kimochi(.exe)` elsewhere. Rebuild after changes. |
| `npm run dev` | Rebuilds `dist/` (`prepare.mjs`), then `tauri dev` with live reload (see [Dev mode](#dev-mode)). Stages OCR assets only if they have never been staged. |
| `npm run check:rust` | `cargo clippy -D warnings` for `src-tauri`. |
| `npm run check:all` | `check:rust`, plus `cargo check` of `capture-core` for `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` and `x86_64-unknown-linux-gnu` (each skipped with a hint unless `rustup target add` has been run). A convenience only: native CI on each OS is the real compile gate. |
| `npm run prepare:meikiocr -- --target <triple>` | Stage the ONNX Runtime for another Rust target (also `KIMOCHI_TARGET`); `MEIKIOCR_DEST` stages into another directory. `prepare:mangaocr` accepts the same flag (its models are platform-neutral). |

`npm run bundle -- --target <triple>` cross-builds when the toolchain allows it and stages the matching OCR runtime. `npm run preview:ui` renders every window in Chrome against mocked native commands for design work.

### Dev mode

`npm run dev` runs `tauri dev`, which starts the Vite dev server in `vite.dev.config.ts` (`build.beforeDevCommand`) and loads every window from it at `build.devUrl`, `http://127.0.0.1:1430`. That is the origin `tauri dev`'s built-in static server used before, so the dev build keeps its dictionaries (IndexedDB is per origin). One origin serves both halves of the app:

- `/app/*`: the React windows from `frontend/`. Edits apply through Vite HMR without a reload.
- everything else: the prepared `dist/` tree (Yomitan, `dist/spike/` from `host/`, `dist/ui/` from `ui/`). Editing `ui/` redoes that `prepare.mjs` step and reloads the plain `ui/` windows (overlay, dictionary popup host, ...); `ui/panel-yomitan.js`, which the panels load at runtime, reloads every window.
- `src-tauri/` edits rebuild and relaunch the app (`tauri dev`'s own watcher). So do `host/` edits: the dev server copies them into `dist/spike/`, and the app relaunches because native injects `host/shim.js` and `host/panel-shim.js` when a window is created.

Quitting the app or pressing Ctrl-C stops `tauri dev` and the dev server with it. Port 1430 must be free; `KIMOCHI_DEV_PORT=1431 npm run dev` runs a second checkout alongside (that origin starts with empty dictionaries). A bare `npx tauri dev` also works, but skips OCR staging and reloads windows for `host/` edits instead of relaunching (restart it yourself after editing the two injected shims). Bundles (`npm run bundle`/`release`) never use the dev server: they `vite build` into `dist/app/` and embed `dist/`.

### Prerequisites per OS

- **macOS** (the implementation target): macOS 14+, Node 22+, Rust stable and the Command Line Tools. Always launch the bundle: a bare executable can have a different WebKit IndexedDB identity and appear to lose dictionaries. `npm run release` produces `src-tauri/target/release/bundle/macos/Kimochi.app`; install by copying it to `/Applications`.
- **Windows** 10 22H2 or 11, x64 or ARM64: Node 22+, Rust stable (MSVC toolchain) and the Visual Studio Build Tools "Desktop development with C++" workload. The installer embeds the WebView2 bootstrapper and installs per user (no admin). Capture, overlay and input are not implemented yet (see [CROSS_PLATFORM_PLAN.md](CROSS_PLATFORM_PLAN.md)).
- **Linux** (Ubuntu 22.04 or newer): Node 22+, Rust stable >=1.87 and `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf pkg-config libpipewire-0.3-dev libpipewire-0.3-modules pipewire-bin libspa-0.2-dev libclang-dev libudev-dev libgstreamer1.0-dev gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad`. See [Linux dependencies and capabilities](src-tauri/src/platform/linux/DEPS.md) and the session-specific [Ubuntu report](UBUNTU_BRINGUP.md).

### Configuration split

`src-tauri/tauri.conf.json` is the shared base. Tauri merges `tauri.macos.conf.json`, `tauri.windows.conf.json` or `tauri.linux.conf.json` over it for the platform being built (JSON Merge Patch: objects merge key by key, arrays are replaced whole). The macOS file carries the `app` bundle target, `minimumSystemVersion` and the darwin keytrigger binaries, and the merged macOS result is identical to the former single file. The Windows file carries NSIS (`currentUser`, English and Japanese), the WebView2 bootstrapper, `.ico`-first icons and the signing hook. The Linux file carries `deb`/`appimage` and the runtime package dependencies. `app.macOSPrivateApi` stays in the base on every platform: tauri-build requires the config to match the `macos-private-api` feature declared in `Cargo.toml`, and the flag has no effect off macOS.

### Signing

macOS: the runner sets `DEVELOPER_DIR=/Library/Developer/CommandLineTools` for builds (not for `npm run dev`). It uses an installed Apple Development signing identity when available, or `APPLE_SIGNING_IDENTITY`. `KIMOCHI_ADHOC=1` opts out. This is a local development bundle, not a notarized release; no signing keys are stored here.

Windows: `bundle.windows.signCommand` runs `node ../scripts/sign-windows.mjs %1` for each binary. It signs with Azure Artifact Signing through `artifact-signing-cli` (`cargo install artifact-signing-cli`) when `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `KIMOCHI_SIGNING_ENDPOINT`, `KIMOCHI_SIGNING_ACCOUNT` and `KIMOCHI_SIGNING_PROFILE` are set. Without them it leaves the file unsigned with a warning, unless `KIMOCHI_REQUIRE_SIGNING=1`.

### CI

`.github/workflows/ci.yml` runs tests, typecheck, lint, clippy and the `capture-core` tests on macOS, Windows x64, Windows ARM64, Linux x64 and Linux ARM64, then builds a bundle on each and uploads it; a `v*` tag turns those into a draft GitHub Release. It runs on our own machines as self-hosted runners (free, no Actions minutes), set up and documented in [ci/runners/README.md](ci/runners/README.md). macOS bundles are ad-hoc signed. Windows bundles are signed only when the Azure secrets exist. CI checks the sibling OCR crates out beside this repository through read-only deploy keys.

## Integrated Texthooker

The **Log** window now hosts Super Texthooker: sessions, transcript actions, reading statistics, notebooks and dictionary lookups. Settings → **Texthooker** contains OCR/Clipboard/WebSocket input cards, optional OCR outputs and reading tools. **Notebook** opens characters, places, notes and VNDB import in its own window. Main settings use a sidebar; all panel title bars share compact chrome. Window captures can resume a matching session; manually choosing or creating a session overrides the association. Display captures keep the manually selected session.

See [TEXTHOOKER_INTEGRATION.md](TEXTHOOKER_INTEGRATION.md) for architecture, reused code, validation and the short integration checklist.

## Main workflow

- **Controller → Source:** a separate native popover lists screens first, then app windows with local thumbnails and icons. Select one to fill the preview area, drag an optional crop, then Continue. Changes apply only on save.
- **Select Region:** screen sources use desktop region selection followed by an immediate scan; window sources edit their crop in the picker.
- **Scan / automatic OCR:** use the existing Kimochi cloud service or local server, with optional change detection, local OCR gating and adaptive polling. Settings also exposes MeikiOCR, Manga OCR and OwOCR modes. MeikiOCR reads Japanese game text locally and returns selectable overlay boxes. Manga OCR detects page text blocks and recognizes each group locally; OwOCR requires its separate WebSocket service.
- **Settings:** OCR, Shortcuts, Gamepad, Dictionary, Audio and Texthooker retain the Electron controls. Source selection has moved out of Settings.
- **Log:** scan history, font size, opacity, selection, dictionary lookup, per-entry audio/delete and clear-all. Controller, Log, Settings and diagnostic views are independent native windows with the original title bars and controls.
- **Dictionary:** Open Yomitan Settings reaches the original extension settings/import UI. Import your dictionaries there; dictionary contents live in IndexedDB. The extension compatibility adapter is not native browser-extension support.

Source previews stay local. A cloud/server OCR scan sends the selected capture or crop to that service. MeikiOCR and Manga OCR process pixels in the app. No user screenshots are written to this experiment's reports.

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

## Local MeikiOCR

Select **MeikiOCR** in **Settings → OCR & Overlay → Engine** (or the sidebar's OCR model picker). Both manual and automatic scans use the same retained capture and publication/freshness guards. Japanese text and line boxes feed the overlay, log, texthooker and audio. Sessions load on the first scan and are then reused. Cloud OCR remains the default.

`npm run bundle` and `npm run release` automatically stage a pinned ONNX Runtime (1.30.0 on Apple Silicon; 1.22.0 on other targets) under `src-tauri/resources/meikiocr/runtime/` and include it in the app bundle. The three ONNX models (about 46 MB) are **not** bundled: the first time MeikiOCR is selected (after a confirmation that names the size), the app downloads them from their pinned Hugging Face revisions into `<app local data>/models/meikiocr/`, verifies each file's size and SHA-256, and shows the progress in MeikiOCR's panel in **Settings → OCR & Overlay → Engine** and beside the sidebar's OCR model picker (Pause, Resume, Retry and Cancel sit beside the bar; removing a downloaded model is in the panel's overflow menu). The pinned list is `src-tauri/ocr-models.json`; see `COMMANDS.md` → OCR model downloads. Once downloaded, scans are offline and end users need no Python, Node or separate server. `npm run prepare:meikiocr` stages the runtime separately; `npm run prepare:meikiocr -- --with-models` (or `KIMOCHI_WITH_MODELS=1`) also stages a development copy of the models under `src-tauri/resources/meikiocr/models/`, which a development build uses instead of downloading and which is never bundled. The Rust library lives in the sibling `../kimochi-meikiocr` checkout, which must be available when building.

The default native runtime includes Core ML on macOS and DirectML on Windows. Linux builds use CPU by default; `MEIKIOCR_RUNTIME_FLAVOR=cuda npm run prepare:meikiocr` stages the CUDA runtime on Linux/Windows x64. CUDA drivers and the runtime's matching CUDA/cuDNN dependencies must be installed on the target PC. `MEIKIOCR_RUNTIME_DIR=/path/to/native/runtime` supplies an alternative runtime directory (include all native dependencies and licenses). `--target <rust-triple>` (or `KIMOCHI_TARGET`) selects the runtime for a cross-build; `npm run bundle -- --target <triple>` passes it through. The staged `runtime/build.json` records the triple, so a runtime staged for another target is replaced automatically. On Windows the DirectML runtime ships `onnxruntime.dll`, `onnxruntime_providers_shared.dll` and the `DirectML.dll` version the ORT package declares, from Microsoft's NuGet package, with its licences. (`MEIKIOCR_ARCH` still selects the architecture on the host OS.) Runtime selection tries supported accelerators and falls back to CPU; unsupported operations may still run on CPU.

Prepared binary assets are ignored by Git. Source and runtime licenses/notices travel with the bundle. The macOS build runner signs native runtime libraries with the same identity as the app, satisfying hardened-runtime library validation. Runtime archives come from Microsoft's version-pinned GitHub release and NuGet, are checked against the SHA-256 table in `scripts/prepare-meikiocr.mjs` (only opt-in CUDA archives are unpinned, with a warning), and are extracted in-process with no `tar`/`unzip` dependency. Native runtime downloads run in the build process, never inside the app; the only download the app itself makes is the on-demand model download above, checked against the hashes in `src-tauri/ocr-models.json`.

Validation includes the JavaScript routing tests and Rust annotation-contract test. The real-model test uses the staged runtime, the development copy of the models (`npm run prepare:meikiocr -- --with-models`) and upstream Japanese example:

```sh
MEIKIOCR_TEST_IMAGE=/path/to/meikiocr-example.jpg cargo test \
  --manifest-path src-tauri/Cargo.toml meiki_ocr -- --include-ignored
```


## Local Manga OCR

Select **Manga OCR** in **Settings → OCR & Overlay → Engine** (or the sidebar's OCR model picker). Choose a Japanese manga text bubble or small text region; this model recognizes whole crops and does not detect text blocks on full pages. Manual, Quick Shot and automatic scans use the retained capture and the existing freshness guards. Text feeds the log, texthooker, clipboard and audio; this backend has no selectable overlay boxes.

The Manga OCR weights, vocabulary, config and Comic Text Detector (about 539 MB) are **not** bundled; only their licences are. The first time Manga OCR is selected, the app downloads them into `<app local data>/models/mangaocr/` with the same verification, progress and controls as MeikiOCR (resumable: a paused, interrupted or quit download continues from its partial file). `npm run prepare:mangaocr -- --with-models` (or `KIMOCHI_WITH_MODELS=1`) stages a development copy under `src-tauri/resources/mangaocr/models/`, reusing verified files from `../kimochi-mangaocr/models` or `MANGAOCR_MODEL_DIR` before downloading. The sibling `../kimochi-mangaocr` checkout is required to build. Inference is offline and needs no Python or native inference runtime.

The model loads lazily and is reused on a blocking worker. macOS builds enable Metal GPU acceleration automatically; other platforms use CPU. NVIDIA builds can enable the Rust feature `mangaocr-cuda` (with a compatible CUDA toolkit and drivers); CUDA is not validated on this Mac. Cloud remains the default. Backend/device and generation metadata are returned in native diagnostics.

```sh
npm run prepare:mangaocr
MANGAOCR_TEST_IMAGE=../kimochi-mangaocr/tests/fixtures/images/00.jpg cargo test \
  --manifest-path src-tauri/Cargo.toml manga_ocr -- --include-ignored --nocapture
```

OCR results share an engine-independent group contract in `ui/ocr-result.ts`. Manga OCR supplies semantic text blocks; fragmented cloud results are grouped by glyph-relative proximity and direction. Direction metadata takes priority over aspect/neighbor inference. Vertical overlays use Japanese vertical layout and a right-edge blue marker; transcript rows remain horizontal, one row per group, with capture boundaries and group counters. Group IDs survive history persistence/replay. Existing text-only engines remain supported. Tesseract is removed; saved `local` OCR preferences migrate to MeikiOCR.

Manga assets, including the Comic Text Detector ONNX file, are checksum-pinned in `src-tauri/ocr-models.json` and downloaded on demand. Its graph runs in Rust via Candle (Metal on macOS), without Python or ONNX Runtime. The combined app is GPL-3.0-only; see `LICENSE` and the detector/recognizer provenance in `NOTICE`.


### Optional GNOME 46 Wayland overlay (Ubuntu prototype)

On GNOME 46 Wayland, **Set up GNOME overlay** installs the extension embedded in
this Linux build. Initial installation (or migration from the old monolithic
extension) requires one login so GNOME discovers the stable loader. Subsequent
**Update GNOME overlay** operations stage an immutable implementation, disable/enable
only Kimochi, verify its running revision and restore the previous implementation
if startup fails. Other enabled extension names are preserved. Unrecognized edits
to Kimochi's loader/metadata are refused; the recognized legacy implementation is
backed up before migration. No unsafe Shell evaluation or compositor restart.

Shell actors provide one monitor's screen annotations and Shift-hover/click lookup.
The dictionary uses the existing full Yomitan Popup/Display in a small native
window, including dictionary images, audio controls and nested lookup. GNOME supplies
geometry for Kimochi's own log/popup windows so log lookups can extend outside the
log. The popup does not request activation when mapped; clicking it can focus it.
The hidden OCR WebKit host never becomes a transparent ordinary desktop overlay.
There is no modal or keyboard grab. Portal window annotations/following remain
deferred, GNOME desktop crop/Quick Shot and multi-monitor mapping remain unavailable.
Full UI/placement and loader recovery have isolated GNOME46 evidence; physical
focus/input/audio acceptance on the user's current desktop is tracked separately
in UBUNTU_BRINGUP.md. Other GNOME versions are rejected until tested.

Safety update: when GNOME annotations are visible, the panel exposes **Hide Kimochi**. This clears them until a new OCR scan; heartbeat updates cannot undo dismissal. Fullscreen overlays are hidden while the panel control is unavailable. Ordinary application Escape is not intercepted.

### Steam Deck Gaming Mode (experimental)

Linux bundles also produce `Kimochi_*-gaming-mode.tar.gz` beside the AppImage.
Extract it in Desktop Mode and run `sh install-gaming-mode.sh ./Kimochi.AppImage`.
Then use Steam's **Add a Game → Add a Non-Steam Game → Kimochi Gaming Mode**.
The entry launches a background user service; pressing Play again reopens controls
or starts the app after Quit. Installation is user-local, requires no system
partition changes, and uses 1× GTK rendering with 1.5× controls UI by default.
Install a newer archive with the same command, quit Kimochi, and press Play again.
Its stable library entry and app data persist; previous versions remain available
for rollback. This helper is a manual update path, not an automatic updater.

Launch with `sh scripts/steam-deck/launch-gaming-mode.sh /path/to/Kimochi.AppImage`.
The launcher selects the Gamescope XWayland overlay renderer and portal capture,
and uses GTK's 2× rendering scale for the Deck's small display. This affects only
the launched process; desktop scaling and saved interface preferences stay intact.
Use `KIMOCHI_GAMESCOPE_SCALE=1` before the command for normal size (integer values
1–4 are supported). Capture pixels retain their original resolution, with overlay
placement and input regions converted using the reported GTK scale.

For an SSH-launched test that survives disconnects, use
`KIMOCHI_GAMESCOPE_SCALE=1 KIMOCHI_GAMESCOPE_UI_SCALE=1.5 sh scripts/steam-deck/launch-gaming-mode-service.sh /absolute/path/to/Kimochi.AppImage`.
This creates a transient user service, with no auto-start or automatic restart;
Quit still exits the app. Main/settings browser UI can use a fractional scale
(1–4, including 1.25 and 1.5); annotation/capture coordinates keep the native GTK
scale. Gaming Mode panels fit the output rather than enforcing desktop minimum
sizes. These options do not affect ordinary desktop launches.

A Steam non-game shortcut can target
`sh scripts/steam-deck/launch-from-steam.sh /absolute/path/to/Kimochi.AppImage`.
The shortcut starts the sidecar service and exits; pressing Play again reopens
controls or starts a fresh app after Quit. Steam may therefore show Play instead
of a running game. The installer supplies a desktop entry and icon; Steam's
one-time Add a Non-Steam Game step remains manual. The older Deck development
shortcut is named `kimochi_steamdeck`.

Kimochi temporarily enables native touch passthrough while its controls have focus, including
native dictionary file dialogs, then restores the game's touch mode. An independent
watchdog restores that mode if the app exits or crashes.

For the current Gaming Mode test flow:

1. Start Kimochi with that launcher; Gaming Mode automatically selects its shared
   screen at startup. Choose Source remains available to retry. Choose an OCR
   engine and install your Yomitan dictionary. MeikiOCR runs locally on the Deck CPU.
2. Use the main window's **Minimize** button to return to Steam without quitting
   Kimochi. Launch your game normally; Kimochi keeps running in the background.
3. Click **both sticks together** to open the radial menu. Use the D-pad or left
   stick and **A** to choose **Scan**, **Read Along**, **Auto OCR**, **Recent text**,
   **Kimochi**, or **OCR settings**. D-pad steps around the expanded ring.
   **Kimochi** returns to the controls; minimize those controls to return again.
4. In reading mode, use the D-pad/left stick to navigate text, **LB/RB** to step
   through definitions, and the right stick to scroll. **B** or the menu chord
   closes reading mode and releases Kimochi's input focus.

**Recent text** opens durable scan history without taking another screenshot or
republishing old OCR. Choose an entry with **A** to navigate its words; **B**
returns to the list, then **B** returns to the game. The separate GNOME Shell
controller host currently directs history reading to Kimochi instead.

Controls and setup share controller focus navigation: D-pad/left stick moves
focus, **A** activates or edits a field, right stick scrolls, and **B** closes a
dialog, leaves editing, or goes back. Touch and mouse remain available. Text
entry uses an app-owned controller keyboard for supported fields; Japanese IME
still uses a physical or system keyboard. Custom action bindings are
suppressed while a control panel has focus, except the radial-menu chord.

Gaming Mode reads the running graphics game's Steam ID independently of input
focus and names it from local Steam manifests where available. Its crop and
reader session follow that identity rather than the temporary portal stream.
**Change game profile** supplies a named manual profile for emulators or
unrecognized games; **Use detected game** resumes automatic matching. OCR engine
selection remains global. Ordinary desktop window/session matching is unchanged.

The shared first-run guide now opens until setup is completed. It offers the
existing OCR engine/model controls, an on-demand recommended dictionary setup,
optional existing dictionary/settings imports inside the guide, and a sample
dictionary lookup. No separate browser extension is required. Setup can be
reopened from Settings → General → Welcome guide.

The explicit Gamescope launcher enables a read-only physical Deck controller
stream, because Steam's virtual gamepad can be silent outside an active game
profile. Automatic controller selection prefers this stream; an explicitly
selected external controller is respected. Steam's dedicated system buttons
remain unbound by Kimochi. No device grab or controller-mode command is sent.
Controller mode temporarily pauses Steam's direct controller reader so Steam
cannot navigate behind Kimochi. An independent watchdog resumes Steam on close,
app exit/crash, or missed webview heartbeats; Steam's own UI/client processing
pauses while this mode is active. Physical menu navigation and B-close have been
verified over Steam's library. Steam/Quick Access presses are intended to close
controller mode and return control to Steam; physical acceptance is pending.
For initial real-game testing, pause the game before reading: game compatibility,
Steam services during long reading sessions and Steam/QAM coexistence remain
acceptance gates. The installation companion and new controller/setup/history
features have offline checks and an ARM64 bundle build; their latest physical
Deck acceptance remains pending. Autostart is not installed.

GNOME caches the stable loader's entry module for the login. A change to the loader
itself still needs a new login; ordinary implementation updates use unique module
paths and reload in place. The UI reports whether the expected revision is actually
running rather than treating an enable command's success as proof.
