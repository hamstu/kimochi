# Contributing

Kimochi is open source under the GPL, built mostly by one person for their own reading. The source
is here so you can read it, build it, learn from it and fork it. Thoughtful contributions and good
bug reports are welcome; that said, this is not a project that is building a team or taking
feature requests, so please don't be surprised if an idea is declined or a PR sits for a while.

- **Bugs**: open an issue with your OS, the Kimochi version (Settings → General), the OCR engine
  and dictionary engine you use, and what you expected to happen.
- **Pull requests**: small and focused, one change each, with tests where the code has them. For
  anything large (a new engine, a new window, a refactor), open an issue first and describe the
  change, so neither of us wastes an afternoon.
- **Licence**: contributions are accepted under the project's [GPL-3.0](LICENSE).

## Development workflow

Set up as in the README's [Building from source](README.md#building-from-source).

Branch from `main`, then before opening a PR run:

```sh
npm test             # node --test over scripts/*.test.mjs (first run downloads the dictionary engines)
npm run typecheck
npm run lint
npm run check:rust   # cargo clippy -D warnings
```

CI runs the same checks, plus the `capture-core` tests and a bundle, on macOS, Windows and Linux.

On macOS, Screen Recording permission belongs to the certificate an app was signed with, not just
its bundle id. `npm run bundle` signs with your Developer ID certificate if you have one (else
Apple Development, else ad-hoc). If you switch between builds signed differently (a local bundle,
a CI build, an ad-hoc one), System Settings can show Kimochi as allowed while capture is still
refused. Clear the old grant and allow it again:

```sh
tccutil reset ScreenCapture dev.kimochi.app
```

**UI work without the native app.** `npm run preview:ui` serves every window in Chrome against
mocked native commands, so panels can be designed and checked in a browser. The mocks and the
preview state live in [frontend/dev/preview-setup.ts](frontend/dev/preview-setup.ts).
`npm run studio` opens the same pages in the UI studio: each window on a desktop where it can be
moved and resized, the overlay and Gaming Mode on a screen of their own, a side panel that sets the
state the page starts in (with JSON for anything bigger), and a copy-edit mode that collects text
changes made in place. Its catalogue of states is in [frontend/dev/studio/](frontend/dev/studio/).

**Design rules.** Components come from the kit, whose usage rules are in
[frontend/kit/README.md](frontend/kit/README.md); colours, type and spacing are in
[DESIGN.md](DESIGN.md). Native commands and events are documented in [COMMANDS.md](COMMANDS.md):
update it alongside any change to the interface.

**Working on the OCR crates.** `src-tauri/Cargo.toml` pins
[kimochi-meikiocr](https://github.com/hamstu/kimochi-meikiocr) and
[kimochi-mangaocr](https://github.com/hamstu/kimochi-mangaocr) to exact git revisions, so every
build names the source it was made from. To build against local checkouts instead, clone them
beside this repository and create the gitignored `.cargo/config.local.toml` (paths are relative
to the repository root):

```toml
paths = ["../kimochi-meikiocr", "../kimochi-mangaocr"]
```

Cargo then compiles your checkouts, and the OCR staging scripts copy their licences and model
manifest from them (they ask `cargo metadata`, see `scripts/ocr-crates.mjs`); `Cargo.lock` keeps
the pinned revisions. The override applies to cargo run from inside this repository (npm scripts,
`tauri`), and needs the checkouts to keep the pinned revision's dependencies; while you change a
crate's dependencies, use a `[patch."https://github.com/hamstu/kimochi-mangaocr"]` table there
instead, and don't commit the `Cargo.lock` it rewrites. Delete the file to build the pins again.
To move a pin, push the crate change, set the new full commit SHA as `rev` in `src-tauri/Cargo.toml`
(both `mangaocr` lines), then run `cargo update -p mangaocr` (or `meikiocr`) in `src-tauri/` and
commit both files.

**Changelog.** If a user would notice your change, add a `- ` line under `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md), written for the person using the app. These lines become the
release notes and the app's "What's new". Refactors, CI and tests don't need one.

**Releases** are cut by the maintainer. `main` is the development line: every push that changes the app
refreshes the rolling `nightly` pre-release (website- and documentation-only pushes build nothing), and nothing on `main` is offered to users as an update. A release
is a `v<x.y.z>` tag made by `npm run release -- <x.y.z>` on a clean `main`; CI builds, signs and
publishes it, and installed copies update to it. Never bump the version or tag by hand.

## Commands

| Command | What it does |
| --- | --- |
| `npm run bundle` | Debug bundle for this OS: `.app` (macOS), NSIS `-setup.exe` (Windows), `.deb` + `.AppImage` (Linux), under `src-tauri/target/debug/bundle/`. Stages the OCR runtime and licences first; the OCR models are downloaded by the app on demand, not bundled. |
| `npm run release:bundle` | Optimised bundle for this OS, under `src-tauri/target/release/bundle/`. |
| `npm run release -- <x.y.z>` | Cuts a release: bumps the version, moves `CHANGELOG.md`'s Unreleased entries under it, commits, tags `v<x.y.z>` and pushes; CI builds and publishes it (see Releases above). `--dry-run` checks and shows the changes without writing anything. |
| `npm start` | Launches the **already-built** debug output: `open`s `Kimochi.app` on macOS, starts `target/debug/kimochi(.exe)` elsewhere. Rebuild after changes. |
| `npm run dev` | Rebuilds `dist/` (`prepare.mjs`), then `tauri dev` with live reload (see the README). Stages OCR assets only if they have never been staged. The main window and panels can be screenshotted and screen-recorded; the OCR overlay and pop-ups are excluded from capture. |
| `npm run dev:local` | `npm run dev` against a local Kimochi server, for account and cloud work (maintainers only: the server's source is not public). Finds the server repository (`KIMOCHI_SERVER_DIR`, else `../kimochi-server`), applies its new local D1 migrations, starts the server (wrangler on :3000) and the website (`site:dev`, Vite on :1450) unless they already answer, then runs the app with `KIMOCHI_SERVER=local`. A debug build reads that over the server setting; Settings → Account shows the server in use and, in debug builds, switches between production and local without a restart (each keeps its own sign-in). Quitting the app or Ctrl-C stops only what the script started. `npm run dev:local -- --servers-only` starts just the server and website. |
| `npm run check:rust` | `cargo clippy -D warnings` for `src-tauri`. |
| `npm run check:all` | `check:rust`, plus `cargo check` of `capture-core` for `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` and `x86_64-unknown-linux-gnu` (each skipped with a hint unless `rustup target add` has been run). A convenience only: native CI on each OS is the real compile gate. |
| `npm run prepare:meikiocr -- --target <triple>` | Stage the ONNX Runtime for another Rust target (also `KIMOCHI_TARGET`); `MEIKIOCR_DEST` stages into another directory. `prepare:mangaocr` accepts the same flag (its models are platform-neutral). |

Also: `npm run bundle -- --target <triple>` cross-builds when the toolchain allows it and stages the matching OCR runtime; `npm run preview:ui` renders every window in Chrome against mocked native commands.
