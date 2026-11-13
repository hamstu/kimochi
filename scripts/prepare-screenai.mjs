// The Chrome Screen AI worker (screenai/), built and staged for the bundle in
// src-tauri/resources/screenai/. Only this small helper ships with Kimochi: Google's library and
// models are never bundled. Kimochi uses a copy already on the computer (a browser's, or owocr's
// ~/.config/screen_ai) or downloads Google's package from Google's servers when the user asks
// (src-tauri/src/screen_ai.rs).
//
// Windows builds both an x64 and an ARM64 worker: Google publishes the library for x64 only, and
// Kimochi on Windows on ARM runs it in the x64 worker under emulation (or a browser's ARM64
// copy, if it has one, in the ARM64 worker). macOS and Linux build one worker for the target.
//
// On macOS, bundles sign the worker with screenai-worker.entitlements (scripts/run.mjs):
// hardened-runtime library validation would otherwise refuse a library Google signed.
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cargoTargetDir } from './cargo-target-dir.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const destination = path.join(root, 'src-tauri/resources/screenai')
const manifest = path.join(root, 'screenai/Cargo.toml')
const target = process.env.KIMOCHI_TARGET

const builds =
  process.platform === 'win32'
    ? [
        ['x86_64-pc-windows-msvc', 'kimochi-screenai-x64.exe'],
        ['aarch64-pc-windows-msvc', 'kimochi-screenai-arm64.exe']
      ]
    : [[target ?? null, 'kimochi-screenai-worker']]

await mkdir(destination, { recursive: true })
await writeFile(
  path.join(destination, 'README.txt'),
  'kimochi-screenai: the Chrome Screen AI helper (GPL-3.0-only; source in screenai/ of the Kimochi repository).\n' +
    "Google's Screen AI library is not included: Kimochi uses a copy already on this computer or downloads it from Google.\n"
)
for (const [triple, name] of builds) {
  const args = ['build', '--locked', '--release', '--features', 'worker', '--manifest-path', manifest]
  if (triple) args.push('--target', triple)
  const built = spawnSync('cargo', args, { stdio: 'inherit' })
  if (built.error) throw built.error
  if (built.status !== 0)
    throw new Error(
      `Screen AI worker build failed (${built.status})${triple ? ` for ${triple}; install that Rust target and its C++ tools` : ''}.`
    )
  const binary = process.platform === 'win32' ? 'kimochi-screenai-worker.exe' : 'kimochi-screenai-worker'
  const built_path = path.join(
    cargoTargetDir(path.join(root, 'screenai')),
    ...(triple ? [triple] : []),
    'release',
    binary
  )
  await copyFile(built_path, path.join(destination, name))
}
console.log(`Screen AI worker staged in ${path.relative(root, destination)}.`)
