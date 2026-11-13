// rustfmt (or `--check`) over every tracked Rust file in the repository, with the root
// rustfmt.toml. `npm run format` and `npm run format:check` call it after oxfmt. It runs rustfmt
// on the files directly rather than `cargo fmt` per crate, which would resolve each crate's
// dependencies first (and fail without the network or a sibling checkout).
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Vendored code, formatted by its upstream. */
const SKIP = ['src-tauri/patches/']

const check = process.argv.includes('--check')
const root = fileURLToPath(new URL('../', import.meta.url))
const listed = spawnSync('git', ['ls-files', '-z', '--', '*.rs'], { cwd: root, encoding: 'utf8' })
if (listed.status !== 0) {
  console.error(listed.stderr || 'git ls-files failed')
  process.exit(1)
}
const files = listed.stdout.split('\0').filter((file) => file && !SKIP.some((prefix) => file.startsWith(prefix)))
// Every crate is edition 2021. Batches keep the command line short enough for Windows.
let failed = false
for (let i = 0; i < files.length; i += 200) {
  const args = ['--edition', '2021', ...(check ? ['--check'] : []), ...files.slice(i, i + 200)]
  const result = spawnSync('rustfmt', args, { cwd: root, stdio: 'inherit' })
  if (result.error) {
    console.error(`rustfmt could not start (${result.error.message}); install Rust with rustfmt.`)
    process.exit(1)
  }
  if (result.status !== 0) failed = true
}
if (failed) {
  if (check) console.error('Rust code is not formatted: run `npm run format`.')
  process.exit(1)
}
