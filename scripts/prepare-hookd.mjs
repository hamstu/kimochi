// The Text Hooker sidecar (hookd/), built for x64 and i686 and staged for the bundle. Only this
// small helper ships with Kimochi; the hookers it hosts (LunaHook, Textractor) are downloaded on
// demand (src-tauri/src/text_hook/store.rs). The x64 build hosts LunaHook and injects 64-bit
// games; the i686 build injects 32-bit ones. Both run emulated on Windows ARM64.
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
if (process.platform === 'win32') {
  const destination = path.join(root, 'src-tauri/resources/hookd')
  await mkdir(destination, { recursive: true })
  for (const [target, arch] of [
    ['x86_64-pc-windows-msvc', 'x64'],
    ['i686-pc-windows-msvc', 'x86']
  ]) {
    const built = spawnSync(
      'cargo',
      ['build', '--locked', '--release', '--manifest-path', path.join(root, 'hookd/Cargo.toml'), '--target', target],
      { stdio: 'inherit' }
    )
    if (built.error) throw built.error
    if (built.status !== 0)
      throw new Error(`Text hook helper ${arch} build failed (${built.status}). Install the ${target} Rust target and the MSVC x86/x64 C++ tools.`)
    await copyFile(
      path.join(root, `hookd/target/${target}/release/kimochi-hookd.exe`),
      path.join(destination, `kimochi-hookd-${arch}.exe`)
    )
  }
  console.log('Text hook helpers (x64, x86) staged.')
}
