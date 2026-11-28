// The Text Hooker sidecar (hookd/), built for x64 and i686 and staged for the bundle. Only this
// small helper ships with Kimochi; the hookers it hosts (LunaHook, Textractor) are downloaded on
// demand (src-tauri/src/text_hook/store.rs). The x64 build hosts LunaHook and injects 64-bit
// games; the i686 build injects 32-bit ones. Both run emulated on Windows ARM64.
//
// The voice hook DLL (voicehook/hook) is built beside each build, for Audio hooking, and the cursor
// hook DLL (voicehook/cursor), for "Keep the mouse cursor visible in games" (src-tauri/src/game_cursor.rs).
//
// macOS and Linux x64 builds ship the same Windows programs and DLLs, cross-built with MinGW: Kimochi runs
// the helper with a Proton or Wine game's own Wine, inside its prefix, and injects the DLL from
// there (src-tauri/src/text_hook/wine.rs).
// Linux ARM64 builds have no x86 games to hook and ship none.
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cargoTargetDir } from './cargo-target-dir.mjs'
import { macosHookToolchain } from './macos-hook-toolchain.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const destination = path.join(root, 'src-tauri/resources/hookd')
const linuxTarget = process.env.KIMOCHI_TARGET ?? (process.arch === 'x64' ? 'x86_64-unknown-linux-gnu' : process.arch)
const builds =
  process.platform === 'win32'
    ? [
        ['x86_64-pc-windows-msvc', 'x64', 'the MSVC x86/x64 C++ tools'],
        ['i686-pc-windows-msvc', 'x86', 'the MSVC x86/x64 C++ tools']
      ]
    : process.platform === 'darwin'
      ? [
          ['x86_64-pc-windows-gnullvm', 'x64', 'the x86_64-pc-windows-gnullvm Rust target'],
          ['i686-pc-windows-gnullvm', 'x86', 'the i686-pc-windows-gnullvm Rust target']
        ]
      : process.platform === 'linux' && linuxTarget.startsWith('x86_64')
        ? [
            [
              'x86_64-pc-windows-gnu',
              'x64',
              'MinGW-w64 (gcc-mingw-w64-x86-64 and gcc-mingw-w64-i686, or mingw-w64-gcc)'
            ],
            ['i686-pc-windows-gnu', 'x86', 'MinGW-w64 (gcc-mingw-w64-x86-64 and gcc-mingw-w64-i686, or mingw-w64-gcc)']
          ]
        : []

if (['win32', 'linux', 'darwin'].includes(process.platform)) {
  await mkdir(destination, { recursive: true })
  // The bundle names this directory on Linux whether or not it has helpers in it.
  await writeFile(
    path.join(destination, 'README.txt'),
    'kimochi-hookd: the Text Hooker helper (GPL-3.0-only; source in hookd/ of the Kimochi repository).\n'
  )
  const macCompiler = process.platform === 'darwin' ? await macosHookToolchain(root) : null
  for (const [target, arch, tools] of builds) {
    const triple = `${arch === 'x64' ? 'x86_64' : 'i686'}-w64-mingw32`
    const compiler = macCompiler ? path.join(macCompiler, `${triple}-clang`) : `${triple}-gcc`
    const buildEnv = target.includes('-windows-gnu')
      ? {
          ...process.env,
          [`CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`]: compiler,
          ...(macCompiler ? { PATH: `${macCompiler}${path.delimiter}${process.env.PATH}` } : {})
        }
      : process.env
    const built = spawnSync(
      'cargo',
      ['build', '--locked', '--release', '--manifest-path', path.join(root, 'hookd/Cargo.toml'), '--target', target],
      { stdio: 'inherit', env: buildEnv }
    )
    if (built.error) throw built.error
    if (built.status !== 0)
      throw new Error(
        `Text hook helper ${arch} build failed (${built.status}). Install the ${target} Rust target and ${tools}.`
      )
    // MinGW (Linux) builds run under Wine, which before 8.14 has no bcryptprimitives.dll for Rust's
    // ProcessPrng: each helper gets the stand-in (hookd/shim/) in its own folder, the 32-bit one
    // in x86/ so the two can share the name. A Wine that has the DLL loads its own instead.
    const folder = target.includes('-windows-gnu') && arch === 'x86' ? path.join(destination, 'x86') : destination
    await mkdir(folder, { recursive: true })
    await copyFile(
      path.join(cargoTargetDir(path.join(root, 'hookd')), `${target}/release/kimochi-hookd.exe`),
      path.join(folder, `kimochi-hookd-${arch}.exe`)
    )
    if (target.includes('-windows-gnu')) {
      if (folder !== destination) await rm(path.join(destination, `kimochi-hookd-${arch}.exe`), { force: true })
      const gcc = compiler
      const shim = path.join(root, 'hookd/shim')
      const compiled = spawnSync(
        gcc,
        [
          ...['-shared', '-O2', '-s', '-Wl,--kill-at', '-Wl,--enable-stdcall-fixup'],
          ...(macCompiler ? [] : ['-nostartfiles', '-Wl,--entry,0']),
          ...['-o', path.join(folder, 'bcryptprimitives.dll')],
          ...[path.join(shim, 'bcryptprimitives.c'), path.join(shim, 'bcryptprimitives.def'), '-ladvapi32']
        ],
        { stdio: 'inherit' }
      )
      if (compiled.error) throw compiled.error
      if (compiled.status !== 0)
        throw new Error(`The ${arch} bcryptprimitives.dll stand-in failed to build. Install ${tools}.`)
    }
    // MinGW builds would carry their symbols and line tables inside the DLL (MSVC's go to a PDB).
    const env = target.includes('-windows-gnu') ? { ...buildEnv, CARGO_PROFILE_RELEASE_STRIP: 'symbols' } : buildEnv
    const voice = spawnSync(
      'cargo',
      [
        'build',
        '--locked',
        '--release',
        '--manifest-path',
        path.join(root, 'voicehook/Cargo.toml'),
        '-p',
        'vh-hook',
        '-p',
        'vh-cursor',
        '--target',
        target
      ],
      { stdio: 'inherit', env }
    )
    if (voice.error) throw voice.error
    if (voice.status !== 0)
      throw new Error(
        `Voice hook ${arch} build failed (${voice.status}). Install the ${target} Rust target and ${tools}.`
      )
    await copyFile(
      path.join(cargoTargetDir(path.join(root, 'voicehook')), `${target}/release/vhhook.dll`),
      path.join(destination, `kimochi-voicehook-${arch}.dll`)
    )
    await copyFile(
      path.join(cargoTargetDir(path.join(root, 'voicehook')), `${target}/release/kimochicursor.dll`),
      path.join(destination, `kimochi-cursorhook-${arch}.dll`)
    )
  }
  console.log(
    builds.length
      ? 'Text hook helpers, voice and cursor hook DLLs (x64, x86) staged.'
      : 'No text hook helpers for this target.'
  )
}
