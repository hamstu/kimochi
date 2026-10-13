// Where the OCR engine crates' sources are, as Cargo resolved them for src-tauri.
//
// src-tauri/Cargo.toml pins `meikiocr` and `mangaocr` to exact git revisions, which Cargo checks
// out under its own home (~/.cargo/git/checkouts/...). A maintainer can instead point Cargo at local
// checkouts through the gitignored `.cargo/config.local.toml` (CONTRIBUTING.md, "Working on the OCR
// crates"). Either way the staging scripts must copy the LICENSE, NOTICE and model manifest from
// the source the binary is built from, so they ask `cargo metadata` rather than guess a path.
// Cargo reads that override from the working directory's `.cargo/`, so this runs at the repo root.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/** @type {Map<string, string> | undefined} */
let resolved

/**
 * The directory holding a crate's Cargo.toml, for `meikiocr` or `mangaocr`. Fetches the pinned
 * revision on first use if Cargo has not yet.
 * @param {'meikiocr' | 'mangaocr'} name
 * @returns {string}
 */
export function ocrCrateDir(name) {
  if (!resolved) {
    const result = spawnSync(
      'cargo',
      ['metadata', '--format-version', '1', '--manifest-path', path.join(root, 'src-tauri/Cargo.toml')],
      { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }
    )
    if (result.error) throw new Error(`cargo metadata failed: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`cargo metadata failed (${result.status})`)
    resolved = new Map()
    for (const pkg of JSON.parse(result.stdout).packages) {
      if (pkg.name === 'meikiocr' || pkg.name === 'mangaocr') {
        resolved.set(pkg.name, path.dirname(pkg.manifest_path))
      }
    }
  }
  const dir = resolved.get(name)
  if (!dir) throw new Error(`cargo metadata has no ${name} package for src-tauri`)
  return dir
}
