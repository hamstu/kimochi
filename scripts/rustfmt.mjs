// `cargo fmt` (or `--check`) in every Rust crate and workspace in the repository, with the
// root rustfmt.toml. `npm run format` and `npm run format:check` call it after oxfmt.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const CRATES = [
  'src-tauri',
  'capture-core',
  'speech-core',
  'screenai',
  'vocr-core',
  'oneocr-worker',
  'hookd',
  'cli-launcher',
  'voicehook',
  'voicehook/speechcheck'
]

const check = process.argv.includes('--check')
const root = fileURLToPath(new URL('../', import.meta.url))
let failed = false
for (const crate of CRATES) {
  const args = ['fmt', '--manifest-path', `${crate}/Cargo.toml`]
  if (check) args.push('--check')
  const result = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' })
  if (result.error) {
    console.error(`cargo fmt could not start (${result.error.message}); install Rust with rustfmt.`)
    process.exit(1)
  }
  if (result.status !== 0) failed = true
}
if (failed) {
  if (check) console.error('Rust code is not formatted: run `npm run format`.')
  process.exit(1)
}
