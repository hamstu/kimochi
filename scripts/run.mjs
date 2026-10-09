// Task runner behind the npm scripts. Usage: node scripts/run.mjs <task> [extra tauri args]
//
//   launch     open the last debug bundle (macOS .app, or the debug binary on Windows/Linux)
//   dev        prepare, then `tauri dev` with live reload (see "Dev mode" below)
//   bundle     debug bundle for this OS (app | nsis | deb,appimage)
//   release    optimised bundle for this OS
//   check      cargo clippy -D warnings for src-tauri
//   check:all  check, plus `cargo check` of capture-core for the Windows and Linux targets
//
// `bundle`/`release` accept `--target <rust-triple>`; it is passed to tauri and to the OCR
// staging scripts (as KIMOCHI_TARGET) so the bundled runtime matches the binary.
//
// Dev mode: `tauri dev` starts `vite.dev.config.ts` as its `beforeDevCommand` and loads every
// window from it at `build.devUrl` (http://127.0.0.1:1430, the origin `tauri dev`'s built-in static
// server used, so the dev dictionaries in that origin's IndexedDB carry over):
//   - React windows (`frontend/`, served at `/app/`) update through Vite HMR, no reload.
//   - `ui/` edits redo prepare.mjs's `ui/` step into `dist/ui/` and reload the plain `ui/` pages
//     (overlay, popup host, ...); `ui/panel-yomitan.js`, which the panels load at runtime, reloads
//     every window.
//   - Rust edits under `src-tauri/` rebuild and relaunch the app (`tauri dev`'s own watcher), and so
//     do `host/` edits, because native injects `host/shim.js` and `host/panel-shim.js` at window
//     creation (the dev server still copies them into `dist/spike/` first).
// Quitting the app (or Ctrl-C) stops `tauri dev`, which stops the dev server. `KIMOCHI_DEV_PORT`
// moves the dev server, e.g. to run a second checkout alongside; that origin has its own storage.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const task = process.argv[2]
const extra = process.argv.slice(3)
const tasks = ['launch', 'dev', 'bundle', 'release', 'check', 'check:all']
if (!tasks.includes(task)) {
  console.error(`Usage: node scripts/run.mjs <${tasks.join('|')}> [tauri args]`)
  process.exit(2)
}
const darwin = process.platform === 'darwin'
const env = { ...process.env }
// Pin the Apple toolchain for builds. `dev` deliberately runs with the caller's environment, the
// same as a bare `npx tauri dev`, so the two share one cargo cache.
if (darwin && task !== 'dev') {
  env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools'
  env.MACOSX_DEPLOYMENT_TARGET = '14.0'
}
const targetFlag = extra.findIndex((arg) => arg === '--target' || arg.startsWith('--target='))
if (targetFlag >= 0) {
  env.KIMOCHI_TARGET = extra[targetFlag].includes('=')
    ? extra[targetFlag].split('=')[1]
    : extra[targetFlag + 1]
}
const run = (command, args) => spawnSync(command, args, { stdio: 'inherit', env })
const exitOnFailure = (result) => {
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Run package CLIs as `node <their JS entry>`: no `node_modules/.bin` shims, so no `.cmd`
// handling and no shell on Windows.
const require = createRequire(import.meta.url)
function bin(pkg, name) {
  const manifest = require.resolve(`${pkg}/package.json`)
  const { bin: entries } = require(manifest)
  return path.join(path.dirname(manifest), typeof entries === 'string' ? entries : entries[name])
}
const node = (pkg, name, args) => run(process.execPath, [bin(pkg, name), ...args])

if (task === 'launch') {
  if (darwin) {
    exitOnFailure(run('open', ['src-tauri/target/debug/bundle/macos/Kimochi.app']))
    process.exit(0)
  }
  const executable = path.join(
    'src-tauri/target/debug',
    process.platform === 'win32' ? 'kimochi.exe' : 'kimochi'
  )
  if (!existsSync(executable)) {
    console.error(`${executable} not found; run \`npm run bundle\` (or \`npm run dev\`) first.`)
    process.exit(1)
  }
  spawn(path.resolve(executable), [], { detached: true, stdio: 'ignore', env }).unref()
  process.exit(0)
}

// Use an installed local development certificate when available. Never store key material.
if (
  darwin &&
  (task === 'bundle' || task === 'release') &&
  !env.APPLE_SIGNING_IDENTITY &&
  !env.KIMOCHI_ADHOC
) {
  const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  })
  const match = identities.stdout?.match(/([A-F0-9]{40}) "Apple Development:/)
  if (match) {
    env.APPLE_SIGNING_IDENTITY = match[1]
    console.log('Using installed Apple Development identity for this local bundle.')
  }
}

await (await import('./prepare.mjs')).prepare()

const ocrResources = ['src-tauri/resources/meikiocr', 'src-tauri/resources/mangaocr']
// Written last by each staging script, so their presence means a complete earlier run.
const ocrStaged = [
  'src-tauri/resources/meikiocr/runtime/build.json',
  'src-tauri/resources/mangaocr/model-manifest.json'
]
// Each OCR script reads KIMOCHI_TARGET from the environment; they run in-process like before.
if (env.KIMOCHI_TARGET) process.env.KIMOCHI_TARGET = env.KIMOCHI_TARGET
if (
  task === 'bundle' ||
  task === 'release' ||
  (task === 'dev' && !ocrStaged.every((file) => existsSync(file)))
) {
  await import('./prepare-meikiocr.mjs')
  await import('./prepare-mangaocr.mjs')
  if (darwin && task !== 'dev') {
    // Hardened-runtime library validation requires the bundled dylib to carry
    // the same signing identity as the app, rather than Microsoft's signature.
    const runtime = 'src-tauri/resources/meikiocr/runtime'
    for (const name of await readdir(runtime)) {
      if (!name.endsWith('.dylib')) continue
      exitOnFailure(
        run('codesign', [
          '--force',
          '--sign',
          env.APPLE_SIGNING_IDENTITY ?? '-',
          '--timestamp=none',
          `${runtime}/${name}`
        ])
      )
    }
  }
} else {
  // tauri-build copies `bundle.resources` at compile time and fails on a missing path. A
  // compile check needs the paths tauri.conf.json names (the runtime directory and the
  // licences), not the runtime or the models themselves; the licences are copied from the
  // sibling engine repositories exactly as the staging scripts copy them.
  for (const dir of ocrResources) await mkdir(dir, { recursive: true })
  await mkdir('src-tauri/resources/meikiocr/runtime', { recursive: true })
  // tauri.windows.conf.json also bundles the OneOCR helper directory (prepare-oneocr.mjs
  // fills it for a real build).
  if (process.platform === 'win32') await mkdir('src-tauri/resources/oneocr', { recursive: true })
  const legal = [
    ['../kimochi-meikiocr/LICENSE', 'src-tauri/resources/meikiocr/LICENSE'],
    ['../kimochi-meikiocr/NOTICE', 'src-tauri/resources/meikiocr/NOTICE'],
    ['../kimochi-mangaocr/LICENSE', 'src-tauri/resources/mangaocr/LICENSE'],
    ['../kimochi-mangaocr/LICENSE-APACHE', 'src-tauri/resources/mangaocr/LICENSE-APACHE'],
    ['../kimochi-mangaocr/NOTICE', 'src-tauri/resources/mangaocr/NOTICE'],
    ['../kimochi-mangaocr/scripts/model-manifest.json', 'src-tauri/resources/mangaocr/model-manifest.json']
  ]
  for (const [from, to] of legal) if (!existsSync(to)) await copyFile(from, to)
}

if (process.platform === 'win32' && ['dev', 'bundle', 'release'].includes(task)) {
  await import('./prepare-oneocr.mjs')
}

if (task === 'dev') {
  const devArgs = ['dev']
  const port = env.KIMOCHI_DEV_PORT
  if (port) devArgs.push('--config', JSON.stringify({ build: { devUrl: `http://127.0.0.1:${port}` } }))
  // `host/shim.js` and `host/panel-shim.js` are injected by native into every frame when a window
  // is created, so a page reload cannot pick up an edit: relaunch the app instead, like a Rust
  // change. tauri cannot watch single files (or honour a `.taurignore` that keeps only two), so
  // all of `host/` relaunches; the dev server then skips its own reload (KIMOCHI_DEV_HOST_RELAUNCH).
  // Absolute, because tauri resolves the folder from `src-tauri/`.
  devArgs.push('--additional-watch-folders', path.resolve('host'))
  env.KIMOCHI_DEV_HOST_RELAUNCH = '1'
  exitOnFailure(node('@tauri-apps/cli', 'tauri', [...devArgs, ...extra]))
  process.exit(0)
}

// The React panels build into `dist/app/`, after prepare.mjs has rebuilt `dist/` from `yomitan/`
// (it wipes the directory first). `dist/app` exists in neither `yomitan/` nor `ui/`, so the
// extension hash verification is unaffected. Dev mode serves them from Vite instead.
if (task !== 'check' && task !== 'check:all') exitOnFailure(node('vite', 'vite', ['build']))

if (task === 'check' || task === 'check:all') {
  exitOnFailure(
    run('cargo', [
      'clippy',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--features',
      'custom-protocol',
      '--',
      '-D',
      'warnings'
    ])
  )
  if (task === 'check') process.exit(0)
  // A convenience cross-check only: the authoritative Windows/Linux gate is native CI, because
  // src-tauri's build scripts and C/C++ dependencies need each target's own toolchain.
  const installed = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' })
  if (installed.error || installed.status !== 0) {
    console.warn('rustup not found; skipping capture-core cross-target checks.')
    process.exit(0)
  }
  const failed = []
  for (const triple of [
    'x86_64-pc-windows-msvc',
    'aarch64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu'
  ]) {
    if (!installed.stdout.split(/\r?\n/).includes(triple)) {
      console.warn(`Skipping capture-core for ${triple}: run \`rustup target add ${triple}\`.`)
      continue
    }
    console.log(`cargo check capture-core --target ${triple}`)
    const result = run('cargo', [
      'check',
      '--manifest-path',
      'capture-core/Cargo.toml',
      '--target',
      triple
    ])
    if (result.status !== 0) failed.push(triple)
  }
  if (failed.length > 0) {
    console.error(`capture-core failed to check for: ${failed.join(', ')}`)
    process.exit(1)
  }
  process.exit(0)
}

let linuxBundler
if (process.platform === 'linux') {
  linuxBundler = await import('./linux-appimage.mjs')
  await linuxBundler.prepareLinuxBundler()
}

// `release` is the optimised, installable app; `bundle` is the faster debug build.
const bundles = { darwin: 'app', win32: 'nsis', linux: 'deb,appimage' }[process.platform]
if (!bundles) throw new Error(`No bundle format configured for ${process.platform}`)
let built = node('@tauri-apps/cli', 'tauri', [
    'build',
    ...(task === 'release' ? [] : ['--debug']),
    '--bundles',
    bundles,
    ...extra
  ])
// A first build may just have downloaded the GTK helper. Retry only after its known fix.
if (built.status !== 0 && linuxBundler && await linuxBundler.prepareLinuxBundler()) {
  built = node('@tauri-apps/cli', 'tauri', ['build', ...(task === 'release' ? [] : ['--debug']), '--bundles', bundles, ...extra])
}
exitOnFailure(built)
if (linuxBundler) await linuxBundler.repairLinuxAppImages({ target: env.KIMOCHI_TARGET, release: task === 'release', env })
