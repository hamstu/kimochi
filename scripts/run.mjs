// Task runner behind the npm scripts. Usage: node scripts/run.mjs <task> [extra tauri args]
//
//   launch     open the last debug bundle (macOS .app, or the debug binary on Windows/Linux)
//   dev        prepare + vite build, then `tauri dev` (dev mode serves the built `dist/`)
//   bundle     debug bundle for this OS (app | nsis | deb,appimage)
//   release    optimised bundle for this OS
//   check      cargo clippy -D warnings for src-tauri
//   check:all  check, plus `cargo check` of capture-core for the Windows and Linux targets
//
// `bundle`/`release` accept `--target <rust-triple>`; it is passed to tauri and to the OCR
// staging scripts (as KIMOCHI_TARGET) so the bundled runtime matches the binary.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
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

await import('./prepare.mjs')

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
  // tauri-build copies `bundle.resources` at compile time and fails on a missing directory.
  // A compile check needs the directories, not the (downloaded) models inside them.
  for (const dir of ocrResources) await mkdir(dir, { recursive: true })
}

// The React panels build into `dist/app/`, after prepare.mjs has rebuilt `dist/` from `yomitan/`
// (it wipes the directory first). `dist/app` exists in neither `yomitan/` nor `ui/`, so the
// extension hash verification is unaffected.
if (task !== 'check' && task !== 'check:all') exitOnFailure(node('vite', 'vite', ['build']))

if (task === 'dev') {
  exitOnFailure(node('@tauri-apps/cli', 'tauri', ['dev', ...extra]))
  process.exit(0)
}

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

// `release` is the optimised, installable app; `bundle` is the faster debug build.
const bundles = { darwin: 'app', win32: 'nsis', linux: 'deb,appimage' }[process.platform]
if (!bundles) throw new Error(`No bundle format configured for ${process.platform}`)
exitOnFailure(
  node('@tauri-apps/cli', 'tauri', [
    'build',
    ...(task === 'release' ? [] : ['--debug']),
    '--bundles',
    bundles,
    ...extra
  ])
)
