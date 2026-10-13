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

<!-- TODO(owner): add one screenshot here (none suitable is committed outside evidence/). -->

## What it is

Kimochi is a free desktop companion for reading Japanese games and visual novels. It reads the
text on screen, draws it back over the game so you can point at any word to look it up, and keeps
a running log of every line with audio, Anki export and a notebook for names and places. It is a
Tauri 2 app (Rust and React), built for macOS first, with Windows and Linux builds.

- **OCR where the text is**: cloud OCR by default, or local engines (MeikiOCR, Manga OCR, Apple
  Live Text on macOS, OneOCR on Windows 11). Auto OCR waits for text to settle, then reads it once.
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

You need Node 22+ and stable Rust, plus per OS: the Xcode Command Line Tools on macOS 14+; the
Visual Studio Build Tools C++ workload on Windows 10 22H2 or 11; the WebKitGTK and PipeWire
development packages on Ubuntu 22.04+ (the full list is in [docs/BUILDING.md](docs/BUILDING.md#prerequisites-per-os)).
The OCR crates are path dependencies, so check out `kimochi-meikiocr` and `kimochi-mangaocr`
beside this repository first.

```sh
npm ci
npm run dev      # the app with live reload
npm run bundle   # a debug bundle for this OS, under src-tauri/target/debug/bundle/
```

No dictionary engine or OCR model is in the repository: the app downloads them on demand, and
the tests fetch a pinned development copy of the engines on their first run. See
[docs/BUILDING.md](docs/BUILDING.md) for dev mode, signing, CI and cross-builds.

## Documentation

- [docs/BUILDING.md](docs/BUILDING.md): building, dev mode, per-OS prerequisites, signing and CI.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the app is put together and what each window does.
- [docs/OCR_ENGINES.md](docs/OCR_ENGINES.md): the local OCR engines and automatic OCR.
- [docs/LINUX_GNOME_AND_STEAM_DECK.md](docs/LINUX_GNOME_AND_STEAM_DECK.md): the GNOME overlay and Steam Deck Gaming Mode.
- [COMMANDS.md](COMMANDS.md): the native command and event interface.
- [DICTIONARY_ENGINES.md](DICTIONARY_ENGINES.md) and [EXTENSION_DOWNLOADS.md](EXTENSION_DOWNLOADS.md): how dictionary engines are hosted and downloaded.
- [OCR.md](OCR.md): the engine-independent OCR result contract.
- [DESIGN.md](DESIGN.md): the visual design system.
- [MANUAL_TESTING.md](MANUAL_TESTING.md): checks that need a person and a real game.
- [RELEASING.md](RELEASING.md) and [CHANGELOG.md](CHANGELOG.md): how releases are cut, and what changed.
- [docs/history/](docs/history/): plans, handoffs and bring-up reports, kept for the record.

## Contributing

Kimochi is source-available under the GPL and open to thoughtful contributions, but it is not
actively looking for features or collaborators. See [CONTRIBUTING.md](CONTRIBUTING.md) before
opening anything large.

## License

[GPL-3.0](LICENSE). Kimochi includes Apache-2.0 code ([LICENSE-APACHE](LICENSE-APACHE)); the
third-party notices, including the OCR models and the dictionary engines it downloads, are in
[NOTICE](NOTICE).
