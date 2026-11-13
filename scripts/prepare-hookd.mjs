// The Text Hooker sidecar (hookd/), built for x64 and i686 and staged for the bundle. Only this
// small helper ships with Kimochi; the hookers it hosts (LunaHook, Textractor) are downloaded on
// demand (src-tauri/src/text_hook/store.rs). The x64 build hosts LunaHook and injects 64-bit
// games; the i686 build injects 32-bit ones. Both run emulated on Windows ARM64.
//
// The voice hook DLL (voicehook/hook) is built beside each build, for Audio hooking.
//
// Linux x64 builds ship the same Windows programs and DLLs, cross-built with MinGW: Kimochi runs
// the helper with a Proton or Wine game's own Wine, inside its prefix, and injects the DLL from
// there (src-tauri/src/text_hook/wine.rs).
// Linux ARM64 builds have no x86 games to hook and ship none.
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cargoTargetDir } from './cargo-target-dir.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const destination = path.join(root, 'src-tauri/resources/hookd')
const linuxTarget = process.env.KIMOCHI_TARGET ?? (process.arch === 'x64' ? 'x86_64-unknown-linux-gnu' : process.arch)
const builds =
  process.platform === 'win32'
    ? [
        ['x86_64-pc-windows-msvc', 'x64', 'the MSVC x86/x64 C++ tools'],
        ['i686-pc-windows-msvc', 'x86', 'the MSVC x86/x64 C++ tools']
      ]
    : process.platform === 'linux' && linuxTarget.startsWith('x86_64')
      ? [
          ['x86_64-pc-windows-gnu', 'x64', 'MinGW-w64 (gcc-mingw-w64-x86-64 and gcc-mingw-w64-i686, or mingw-w64-gcc)'],
          ['i686-pc-windows-gnu', 'x86', 'MinGW-w64 (gcc-mingw-w64-x86-64 and gcc-mingw-w64-i686, or mingw-w64-gcc)']
        ]
      : []

if (process.platform === 'win32' || process.platform === 'linux') {
  await mkdir(destination, { recursive: true })
  // The bundle names this directory on Linux whether or not it has helpers in it.
  await writeFile(
    path.join(destination, 'README.txt'),
    'kimochi-hookd: the Text Hooker helper (GPL-3.0-only; source in hookd/ of the Kimochi repository).\n'
  )
  for (const [target, arch, tools] of builds) {
    const built = spawnSync(
      'cargo',
      ['build', '--locked', '--release', '--manifest-path', path.join(root, 'hookd/Cargo.toml'), '--target', target],
      { stdio: 'inherit' }
    )
    if (built.error) throw built.error
    if (built.status !== 0)
      throw new Error(`Text hook helper ${arch} build failed (${built.status}). Install the ${target} Rust target and ${tools}.`)
    await copyFile(
      path.join(cargoTargetDir(path.join(root, 'hookd')), `${target}/release/kimochi-hookd.exe`),
      path.join(destination, `kimochi-hookd-${arch}.exe`)
    )
    // MinGW builds would carry their symbols and line tables inside the DLL (MSVC's go to a PDB).
    const env = target.endsWith('-gnu') ? { ...process.env, CARGO_PROFILE_RELEASE_STRIP: 'symbols' } : process.env
    const voice = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', path.join(root, 'voicehook/Cargo.toml'), '-p', 'vh-hook', '--target', target], { stdio: 'inherit', env })
    if (voice.error) throw voice.error
    if (voice.status !== 0) throw new Error(`Voice hook ${arch} build failed (${voice.status}). Install the ${target} Rust target and ${tools}.`)
    await copyFile(path.join(cargoTargetDir(path.join(root, 'voicehook')), `${target}/release/vhhook.dll`), path.join(destination, `kimochi-voicehook-${arch}.dll`))
  }
  console.log(builds.length ? 'Text hook helpers and voice hook DLLs (x64, x86) staged.' : 'No text hook helpers for this target.')
}
