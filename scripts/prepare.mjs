/* eslint @typescript-eslint/explicit-function-return-type: "off" -- This standalone spike runs plain JavaScript without a TypeScript build. */
// Builds `dist/`, the app origin: `host/` as `dist/spike/` and `ui/` as `dist/ui/` (every `ui/*.ts`
// compiled to `.js`). The React windows are added to `dist/app/` by `vite build` afterwards.
//
// No dictionary engine is in `dist/`, and so none is in the app binary: Yomitan, Hachidori and 10ten
// are downloaded on demand by the app from their pinned upstream releases and verified file by file
// (src-tauri/src/extension_store.rs, EXTENSION_DOWNLOADS.md). Yomitan is still served at the app
// origin root; its bytes come from the download, through the app's asset layer, not from `dist/`.
//
//   node scripts/prepare.mjs           rebuild `dist/` from scratch, then verify
//   node scripts/prepare.mjs --verify  only verify `dist/` (no engine in it) and the pinned records
//
// The per-directory steps are exported so the dev server (`vite.dev.config.ts`) can redo just the
// step a source change affects, without wiping `dist/` (and the React build beside it).
import { cp, mkdir, rm, readdir, readFile, stat } from 'node:fs/promises'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { checkRecordCopies, extensionIds } from './sync-extension.mjs'
import { buildYomitanShims } from './yomitan-shims.mjs'

export const root = fileURLToPath(new URL('../', import.meta.url))
const at = (...parts) => path.join(root, ...parts)
export const dist = at('dist')

/** `host/` → `dist/spike/`, plus the bundles built from it. */
export async function prepareHost() {
  await cp(at('host'), at('dist/spike'), { recursive: true })
  if (process.platform === 'linux') {
    await build({
      entryPoints: [at('host/linux-popup-fonts.css')],
      outfile: at('dist/spike/linux-popup-fonts.css'),
      bundle: true,
      loader: { '.woff2': 'file', '.woff': 'file' },
      assetNames: 'linux-fonts/[name]-[hash]'
    })
  }
  await build({
    entryPoints: [at('host/network-entry.js')],
    outfile: at('dist/spike/network-bundle.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'safari17'
  })
  // The Yomitan hosts native injects (`shim.js`, `panel-shim.js`), from host/yomitan/.
  await buildYomitanShims(at('dist/spike'))
  await prepareExtensionHost()
}

/**
 * `host/ext/entry.js` → `dist/spike/ext-host.js`, the generic extension host (DICTIONARY_ENGINES.md
 * §5). An IIFE because it is both injected by native as a document-start script and loaded as a
 * plain `<script src>`, so it must install `chrome.*` synchronously and cannot be a module.
 */
export async function prepareExtensionHost() {
  await build({
    entryPoints: [at('host/ext/entry.js')],
    outfile: at('dist/spike/ext-host.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'safari17'
  })
  // The worker shim (host/ext/worker-network.js): extension frames start their module workers
  // through it so the workers' remote requests take the host's network path. Started as a module
  // worker, so ESM.
  await build({
    entryPoints: [at('host/ext/worker-entry.js')],
    outfile: at('dist/spike/ext-worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'safari17'
  })
}

/** `ui/` → `dist/ui/`, with every `ui/*.ts` module compiled to `dist/ui/*.js`. */
export async function prepareUi() {
  await cp(at('ui'), at('dist/ui'), { recursive: true })
  // Globbed rather than listed so the overlay workstream can add modules without touching this
  // script.
  const typescriptModules = (await readdir(at('ui'))).filter((name) => name.endsWith('.ts'))
  for (const name of typescriptModules) {
    await build({
      entryPoints: [at('ui', name)],
      outfile: at('dist/ui', name.replace(/\.ts$/, '.js')),
      format: 'esm',
      target: 'safari17'
    })
  }
  await checkUiSpecifiers()
}

/**
 * Every module in dist/ui is loaded straight from the app origin with no bundler or import map,
 * so a bare or extensionless specifier is a runtime failure that no frontend build would catch.
 */
async function checkUiSpecifiers() {
  const unresolved = []
  for (const name of (await readdir(at('dist/ui'))).filter((file) => file.endsWith('.js'))) {
    const text = await readFile(at('dist/ui', name), 'utf8')
    for (const match of text.matchAll(
      /(?:^|[\s;}])(?:import|export)[^'"()]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    )) {
      const specifier = match[1] ?? match[2]
      if (!specifier) continue
      const relative = specifier.startsWith('./') || specifier.startsWith('../')
      const absolute = specifier.startsWith('/')
      const url = /^[a-z][a-z0-9+.-]*:/i.test(specifier)
      if (!relative && !absolute && !url) unresolved.push(`${name}: ${specifier}`)
      else if (relative && !specifier.endsWith('.js')) unresolved.push(`${name}: ${specifier}`)
    }
  }
  if (unresolved.length > 0) {
    throw Error(
      `dist/ui modules have specifiers a browser cannot resolve:\n  ${unresolved.join('\n  ')}`
    )
  }
}

/**
 * Throws if `dir` (default `dist/`) carries any dictionary engine: an extension tree under `ext/`, or
 * a file of Yomitan's tree at the root (its `manifest.json`, `js/`, `settings.html`, …). The binary
 * embeds `dist/`, so this is what keeps the engines out of the bundle.
 */
export async function checkDistHasNoEngines(dir = dist) {
  const found = []
  if (await stat(path.join(dir, 'ext')).catch(() => null)) found.push('ext/')
  const yomitan = JSON.parse(await readFile(at('extensions/yomitan.sha256.json'), 'utf8'))
  const tops = new Set(Object.keys(yomitan).map((name) => name.split('/')[0]))
  for (const name of await readdir(dir).catch(() => [])) if (tops.has(name)) found.push(name)
  if (found.length > 0) {
    throw Error(`dist/ must not ship a dictionary engine (they are downloaded on demand), but has: ${found.join(', ')}`)
  }
}

/** Throws unless `dist/` holds no engine and every pin's committed record copies are exact. */
export async function verify() {
  await checkDistHasNoEngines()
  for (const id of await extensionIds()) {
    const problems = await checkRecordCopies(id)
    if (problems.length > 0) throw Error(`extensions/${id} records:\n  ${problems.join('\n  ')}`)
  }
  console.log('Verified: dist/ holds no dictionary engine, and the pinned records are exact.')
}

/** Rebuilds `dist/` from scratch (wiping it, including any `dist/app/`), then verifies it. */
export async function prepare() {
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  await prepareHost()
  await prepareUi()
  await verify()
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify')) await verify()
  else await prepare()
}
