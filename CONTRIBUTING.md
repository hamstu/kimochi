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

Set up as in [docs/BUILDING.md](docs/BUILDING.md), with `kimochi-meikiocr` and `kimochi-mangaocr`
checked out beside this repository. Two parity tests also read the Electron app at `../kimochi`;
without it they are reported as skipped.

Branch from `main`, then before opening a PR run:

```sh
npm test             # node --test over scripts/*.test.mjs (first run downloads the dictionary engines)
npm run typecheck
npm run lint
npm run check:rust   # cargo clippy -D warnings
```

CI runs the same checks, plus the `capture-core` tests and a bundle, on macOS, Windows and Linux.

**UI work without the native app.** `npm run preview:ui` serves every window in Chrome against
mocked native commands, so panels can be designed and checked in a browser. The mocks and the
preview state live in [frontend/dev/preview-setup.ts](frontend/dev/preview-setup.ts).

**Design rules.** Components come from the kit, whose usage rules are in
[frontend/kit/README.md](frontend/kit/README.md); colours, type and spacing are in
[DESIGN.md](DESIGN.md). Native commands and events are documented in [COMMANDS.md](COMMANDS.md):
update it alongside any change to the interface.

**Releases** are cut by the maintainer; see [RELEASING.md](RELEASING.md).

## Commands

| Command | What it does |
| --- | --- |
| `npm run bundle` | Debug bundle for this OS: `.app` (macOS), NSIS `-setup.exe` (Windows), `.deb` + `.AppImage` (Linux), under `src-tauri/target/debug/bundle/`. Stages the OCR runtime and licences first; the OCR models are downloaded by the app on demand, not bundled. |
| `npm run release:bundle` | Optimised bundle for this OS, under `src-tauri/target/release/bundle/`. |
| `npm run release -- <x.y.z>` | Cuts a release: bumps the version, moves `CHANGELOG.md`'s Unreleased entries under it, commits, tags `v<x.y.z>` and pushes; CI builds and publishes it (see [Cutting a release](RELEASING.md#cutting-a-release)). `--dry-run` checks and shows the changes without writing anything. |
| `npm start` | Launches the **already-built** debug output: `open`s `Kimochi.app` on macOS, starts `target/debug/kimochi(.exe)` elsewhere. Rebuild after changes. |
| `npm run dev` | Rebuilds `dist/` (`prepare.mjs`), then `tauri dev` with live reload (see [Dev mode](docs/BUILDING.md#dev-mode)). Stages OCR assets only if they have never been staged. |
| `npm run check:rust` | `cargo clippy -D warnings` for `src-tauri`. |
| `npm run check:all` | `check:rust`, plus `cargo check` of `capture-core` for `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` and `x86_64-unknown-linux-gnu` (each skipped with a hint unless `rustup target add` has been run). A convenience only: native CI on each OS is the real compile gate. |
| `npm run prepare:meikiocr -- --target <triple>` | Stage the ONNX Runtime for another Rust target (also `KIMOCHI_TARGET`); `MEIKIOCR_DEST` stages into another directory. `prepare:mangaocr` accepts the same flag (its models are platform-neutral). |

Also: `npm run bundle -- --target <triple>` cross-builds when the toolchain allows it and stages the matching OCR runtime; `npm run preview:ui` renders every window in Chrome against mocked native commands.
