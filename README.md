<!-- TODO(owner): https://kimochi.app is a placeholder; no production domain is configured in site/ yet. -->

<p align="center">
  <a href="https://kimochi.app"><img src="branding/icon-macos.png" width="144" height="144" alt="Kimochi icon"></a>
</p>

<h1 align="center">Kimochi</h1>

<p align="center">Read your games in Japanese: on-screen OCR, pop-up dictionaries and a reading log, beside any game or visual novel.</p>

<p align="center">
  <a href="https://github.com/hamstu/kimochi-tauri/releases/latest"><img src="https://img.shields.io/github/v/release/hamstu/kimochi-tauri?sort=semver&label=release" alt="Latest release"></a>
  <a href="https://github.com/hamstu/kimochi-tauri/actions/workflows/ci.yml"><img src="https://github.com/hamstu/kimochi-tauri/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-3e63dd" alt="Platforms: macOS, Windows, Linux">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-3e63dd" alt="License: GPL-3.0"></a>
</p>

<p align="center">
  <a href="https://kimochi.app"><b>Download Kimochi and learn more at kimochi.app →</b></a>
</p>

<!-- TODO(owner): add one screenshot here. -->

## What it is

Kimochi is a free desktop companion for reading Japanese games and visual novels. It reads the
text on screen, draws it back over the game so you can point at any word to look it up, and keeps
a running log of every line with audio, Anki export and a notebook for names and places. It is a
Tauri 2 app (Rust and React), built for macOS first, with Windows and Linux builds.

- **OCR where the text is**: Google Lens by default (captures are sent to Google), or local
  engines (MeikiOCR, Manga OCR, Apple Live Text on macOS, OneOCR on Windows 11). Auto OCR waits
  for text to settle, then reads it once.
- **Pop-up dictionaries**: Yomitan, Hachidori or 10ten, downloaded on demand from their upstream
  releases, hash-checked and run unmodified, with your own dictionaries.
- **Reading log**: a built-in texthooker with sessions, reading stats, a notebook and VNDB
  import; clipboard and WebSocket texthookers work too.
- **Controller-friendly**: a radial menu and gamepad navigation, including Steam Deck Gaming Mode
  (experimental).

## Install

Download the app from [kimochi.app](https://kimochi.app). Builds are published on
[GitHub Releases](https://github.com/hamstu/kimochi-tauri/releases), and the app updates itself.

## Building from source

You need Node 22+ and stable Rust, plus per OS:

- **macOS 14+**: the Xcode Command Line Tools. Run the bundle rather than the bare executable,
  which can get a different WebKit storage identity and appear to lose your dictionaries.
- **Windows 10 22H2 or 11** (x64 or ARM64): the Visual Studio Build Tools "Desktop development
  with C++" workload. For the OneOCR helpers also `rustup target add x86_64-pc-windows-msvc
  aarch64-pc-windows-msvc` and the MSVC ARM64 build tools.
- **Ubuntu 22.04+**: `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf pkg-config
  libpipewire-0.3-dev libpipewire-0.3-modules pipewire-bin libspa-0.2-dev libclang-dev libudev-dev
  libgstreamer1.0-dev gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad`
  (details in [src-tauri/src/platform/linux/DEPS.md](src-tauri/src/platform/linux/DEPS.md)).

The OCR engines are separate crates ([kimochi-meikiocr](https://github.com/hamstu/kimochi-meikiocr),
[kimochi-mangaocr](https://github.com/hamstu/kimochi-mangaocr)); Cargo fetches them at the exact
revisions pinned in `src-tauri/Cargo.toml`, so there is nothing else to clone:

```sh
git clone https://github.com/hamstu/kimochi-tauri
cd kimochi-tauri
npm ci
npm run dev      # the app with live reload
npm run bundle   # a debug bundle for this OS, under src-tauri/target/debug/bundle/
```

No dictionary engine or OCR model is in the repository. The app downloads the engine you choose
(Yomitan, Hachidori or 10ten) from its pinned upstream release (`extensions/<id>.source.json`),
checks every file against `extensions/<id>.sha256.json` and runs it unmodified; OCR models are
downloaded the same way (`src-tauri/ocr-models.json`). For development,
`node scripts/sync-extension.mjs --all --if-missing` fills a gitignored copy of the engines in
`extensions/<id>/`; `npm test` runs it first, so the first test run needs the network.

`npm run dev` serves every window from a Vite dev server at `http://127.0.0.1:1430`: React
panel edits hot-reload, `ui/` edits reload their window, and `src-tauri/` or `host/` edits
rebuild and relaunch the app. Set `KIMOCHI_DEV_PORT` to run a second checkout alongside.
Local bundles are ad-hoc signed on macOS and unsigned on Windows unless signing is configured
(`scripts/sign-windows.mjs`).

## How it is put together

| Folder | What lives there |
| --- | --- |
| `src-tauri/` | The native app: windows, settings, capture, OCR, input, tray, updater and the texthooker server. Its command interface is documented in [COMMANDS.md](COMMANDS.md). |
| `capture-core/` | Screen and window capture (ScreenCaptureKit, Windows Graphics Capture, PipeWire). |
| `frontend/` | The React windows: controller, settings, log/texthooker, notebook, welcome. Built from the kit in [frontend/kit](frontend/kit/README.md). |
| `ui/` | The always-present overlay: scanning, change detection, OCR backends and the boxes drawn over the game. |
| `host/` | The extension host that runs the downloaded dictionary engines unmodified. |
| `oneocr-worker/` | Small helpers that run Windows' built-in OneOCR. |
| `site/` | The marketing site. |

Settings, history and downloaded engines live in the app's data folder (on macOS,
`~/Library/Application Support/dev.kimochi.app/`); dictionaries live in the webview's IndexedDB.

## Contributing

Kimochi is open source under the GPL and open to thoughtful contributions, but it is not
actively looking for features or collaborators. See [CONTRIBUTING.md](CONTRIBUTING.md) before
opening anything large.

## License

[GPL-3.0](LICENSE). Kimochi includes Apache-2.0 code ([LICENSE-APACHE](LICENSE-APACHE)) and
fonts under the SIL Open Font License ([LICENSE-OFL.txt](LICENSE-OFL.txt)); the third-party
notices, including the OCR models and the dictionary engines it downloads, are in
[NOTICE](NOTICE). The licence files ship inside the app.
