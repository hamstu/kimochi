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

| Command | What it does |
| --- | --- |
| `npm run bundle` | Debug bundle for this OS: `.app` (macOS), NSIS `-setup.exe` (Windows), `.deb` + `.AppImage` (Linux), under `src-tauri/target/debug/bundle/`. Stages the OCR runtimes and models first. |
| `npm run release` | Optimised bundle for this OS, under `src-tauri/target/release/bundle/`. |
| `npm start` | Launches the **already-built** debug output: `open`s `Kimochi.app` on macOS, starts `target/debug/kimochi(.exe)` elsewhere. Rebuild after changes. |
| `npm run dev` | Rebuilds `dist/` (`prepare.mjs` + `vite build`), then `tauri dev`. Dev mode serves the built `dist/`, so rerun it after frontend changes. Stages OCR assets only if they have never been staged. |
| `npm run check:rust` | `cargo clippy -D warnings` for `src-tauri`. |
| `npm run check:all` | `check:rust`, plus `cargo check` of `capture-core` for `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` and `x86_64-unknown-linux-gnu` (each skipped with a hint unless `rustup target add` has been run). A convenience only: native CI on each OS is the real compile gate. |
| `npm run prepare:meikiocr -- --target <triple>` | Stage the ONNX Runtime for another Rust target (also `KIMOCHI_TARGET`); `MEIKIOCR_DEST` stages into another directory. `prepare:mangaocr` accepts the same flag (its models are platform-neutral). |

`npm run bundle -- --target <triple>` cross-builds when the toolchain allows it and stages the matching OCR runtime. `npm run preview:ui` renders every window in Chrome against mocked native commands for design work.

### Prerequisites per OS

- **macOS** (the implementation target): macOS 14+, Node 22+, Rust stable and the Command Line Tools. Always launch the bundle: a bare executable can have a different WebKit IndexedDB identity and appear to lose dictionaries. `npm run release` produces `src-tauri/target/release/bundle/macos/Kimochi.app`; install by copying it to `/Applications`.
- **Windows** 10 22H2 or 11, x64 or ARM64: Node 22+, Rust stable (MSVC toolchain) and the Visual Studio Build Tools "Desktop development with C++" workload. The installer embeds the WebView2 bootstrapper and installs per user (no admin). Capture, overlay and input are not implemented yet (see [CROSS_PLATFORM_PLAN.md](CROSS_PLATFORM_PLAN.md)).
- **Linux** (Ubuntu 22.04 or newer): Node 22+, Rust stable and `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf libgstreamer1.0-dev gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad`. Same caveats as Windows.

### Configuration split

`src-tauri/tauri.conf.json` is the shared base. Tauri merges `tauri.macos.conf.json`, `tauri.windows.conf.json` or `tauri.linux.conf.json` over it for the platform being built (JSON Merge Patch: objects merge key by key, arrays are replaced whole). The macOS file carries the `app` bundle target, `minimumSystemVersion` and the darwin keytrigger binaries, and the merged macOS result is identical to the former single file. The Windows file carries NSIS (`currentUser`, English and Japanese), the WebView2 bootstrapper, `.ico`-first icons and the signing hook. The Linux file carries `deb`/`appimage` and the runtime package dependencies. `app.macOSPrivateApi` stays in the base on every platform: tauri-build requires the config to match the `macos-private-api` feature declared in `Cargo.toml`, and the flag has no effect off macOS.

### Signing

macOS: the runner sets `DEVELOPER_DIR=/Library/Developer/CommandLineTools` for builds (not for `npm run dev`). It uses an installed Apple Development signing identity when available, or `APPLE_SIGNING_IDENTITY`. `KIMOCHI_ADHOC=1` opts out. This is a local development bundle, not a notarized release; no signing keys are stored here.

Windows: `bundle.windows.signCommand` runs `node ../scripts/sign-windows.mjs %1` for each binary. It signs with Azure Artifact Signing through `artifact-signing-cli` (`cargo install artifact-signing-cli`) when `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `KIMOCHI_SIGNING_ENDPOINT`, `KIMOCHI_SIGNING_ACCOUNT` and `KIMOCHI_SIGNING_PROFILE` are set. Without them it leaves the file unsigned with a warning, unless `KIMOCHI_REQUIRE_SIGNING=1`.

### CI

`.github/workflows/ci.yml` runs tests, typecheck, lint, clippy and the `capture-core` tests on macOS, Windows x64, Windows ARM64 and Ubuntu 22.04, then builds a debug bundle on each and uploads it. macOS bundles are ad-hoc signed. Windows bundles are signed only when the Azure secrets exist. CI checks the sibling OCR crates out beside this repository, so they need to be pushed to GitHub first (see the TODO at the top of the workflow).

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

Select **Settings → OCR → OCR engine → Local (MeikiOCR)**. Both manual and automatic scans use the same retained capture and publication/freshness guards. Japanese text and line boxes feed the overlay, log, texthooker and audio. Sessions load on the first scan and are then reused. Cloud OCR remains the default.

`npm run bundle` and `npm run release` automatically stage three pinned, SHA-256-verified ONNX models and a pinned ONNX Runtime (1.30.0 on Apple Silicon; 1.22.0 on other targets) under `src-tauri/resources/meikiocr/`, then include them in the app bundle. `npm run prepare:meikiocr` prepares these assets separately. The first build requires internet access; ordinary scans are offline and end users need no Python, Node, model downloader or separate server. The Rust library lives in the sibling `../kimochi-meikiocr` checkout, which must be available when building.

The default native runtime includes Core ML on macOS and DirectML on Windows. Linux builds use CPU by default; `MEIKIOCR_RUNTIME_FLAVOR=cuda npm run prepare:meikiocr` stages the CUDA runtime on Linux/Windows x64. CUDA drivers and the runtime's matching CUDA/cuDNN dependencies must be installed on the target PC. `MEIKIOCR_RUNTIME_DIR=/path/to/native/runtime` supplies an alternative runtime directory (include all native dependencies and licenses). `--target <rust-triple>` (or `KIMOCHI_TARGET`) selects the runtime for a cross-build; `npm run bundle -- --target <triple>` passes it through. The staged `runtime/build.json` records the triple, so a runtime staged for another target is replaced automatically. On Windows the DirectML runtime ships `onnxruntime.dll`, `onnxruntime_providers_shared.dll` and the `DirectML.dll` version the ORT package declares, from Microsoft's NuGet package, with its licences. (`MEIKIOCR_ARCH` still selects the architecture on the host OS.) Runtime selection tries supported accelerators and falls back to CPU; unsupported operations may still run on CPU.

Prepared binary assets are ignored by Git. Source and runtime licenses/notices travel with the bundle. The macOS build runner signs native runtime libraries with the same identity as the app, satisfying hardened-runtime library validation. Runtime archives come from Microsoft's version-pinned GitHub release and NuGet, are checked against the SHA-256 table in `scripts/prepare-meikiocr.mjs` (only opt-in CUDA archives are unpinned, with a warning), and are extracted in-process with no `tar`/`unzip` dependency. Model hashes are verified against pinned Hugging Face repository revisions. Native asset downloads run in the build process, never inside the app.

Validation includes the JavaScript routing tests and Rust annotation-contract test. The real-model test uses the bundled runtime and upstream Japanese example:

```sh
MEIKIOCR_TEST_IMAGE=/path/to/meikiocr-example.jpg cargo test \
  --manifest-path src-tauri/Cargo.toml meiki_ocr -- --include-ignored
```


## Local Manga OCR

Select **Settings → OCR → OCR engine → Local (Manga OCR)**. Choose a Japanese manga text bubble or small text region; this model recognizes whole crops and does not detect text blocks on full pages. Manual, Quick Shot and automatic scans use the retained capture and the existing freshness guards. Text feeds the log, texthooker, clipboard and audio; this backend has no selectable overlay boxes.

`npm run bundle` and `npm run release` stage the pinned, SHA-256-verified Manga OCR weights (about 424 MiB), vocabulary, config and licenses under `src-tauri/resources/mangaocr/` and bundle them with the app. `npm run prepare:mangaocr` stages assets separately. The script reuses verified files from `../kimochi-mangaocr/models` or `MANGAOCR_MODEL_DIR` before downloading. The sibling `../kimochi-mangaocr` checkout is required to build. Model setup is build-time only; inference is offline and needs no Python or native inference runtime.

The model loads lazily and is reused on a blocking worker. macOS builds enable Metal GPU acceleration automatically; other platforms use CPU. NVIDIA builds can enable the Rust feature `mangaocr-cuda` (with a compatible CUDA toolkit and drivers); CUDA is not validated on this Mac. Cloud remains the default. Backend/device and generation metadata are returned in native diagnostics.

```sh
npm run prepare:mangaocr
MANGAOCR_TEST_IMAGE=../kimochi-mangaocr/tests/fixtures/images/00.jpg cargo test \
  --manifest-path src-tauri/Cargo.toml manga_ocr -- --include-ignored --nocapture
```

OCR results share an engine-independent group contract in `ui/ocr-result.ts`. Manga OCR supplies semantic text blocks; fragmented cloud results are grouped by glyph-relative proximity and direction. Direction metadata takes priority over aspect/neighbor inference. Vertical overlays use Japanese vertical layout and a right-edge blue marker; transcript rows remain horizontal, one row per group, with capture boundaries and group counters. Group IDs survive history persistence/replay. Existing text-only engines remain supported. Tesseract is removed; saved `local` OCR preferences migrate to MeikiOCR.

Manga assets are checksum-pinned and staged by `npm run prepare:mangaocr`, including the Comic Text Detector ONNX file. Its graph runs in Rust via Candle (Metal on macOS), without Python or ONNX Runtime. The combined app is GPL-3.0-only; see `LICENSE` and the detector/recognizer provenance in `NOTICE`.
