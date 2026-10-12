/* eslint @typescript-eslint/explicit-function-return-type: "off" -- This standalone spike runs plain JavaScript without a TypeScript build. */
// Builds `dist/`, the app origin: a byte-identical copy of `yomitan/`, plus `host/` as `dist/spike/`
// and `ui/` as `dist/ui/` (every `ui/*.ts` compiled to `.js`), and each vendored extension in
// `extensions/<id>/` as `dist/ext/<id>/` (served at its own origin, DICTIONARY_ENGINES.md §4), then
// verifies the Yomitan and extension copies.
//
//   node scripts/prepare.mjs           rebuild `dist/` from scratch, then verify
//   node scripts/prepare.mjs --verify  only verify `dist/` against `yomitan/` and `extensions/`
//
// The per-directory steps are exported so the dev server (`scripts/dev-server.mjs`) can redo just
// the step a source change affects, without wiping `dist/` (and the React build beside it).
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { compareHashes, ensureExtension, extensionIds, hashTree, verifyExtension } from './sync-extension.mjs'
import { buildYomitanShims } from './yomitan-shims.mjs'

export const root = fileURLToPath(new URL('../', import.meta.url))
const at = (...parts) => path.join(root, ...parts)
export const dist = at('dist')
const source = at('yomitan')

async function hashes(dir, prefix = '', skip = new Set()) {
  const result = {}
  for (const e of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, e.name)
    if (skip.has(name)) continue
    if (e.isDirectory()) Object.assign(result, await hashes(dir, name))
    // Keys are POSIX paths so the committed evidence file is identical on every OS.
    else
      result[name.split(path.sep).join('/')] = createHash('sha256')
        .update(await readFile(path.join(dir, name)))
        .digest('hex')
  }
  return result
}

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

/**
 * `extensions/<id>/` → `dist/ext/<id>/` for every `extensions/<id>.source.json`. A plain copy:
 * the files are served exactly as upstream released them. The trees are gitignored, so a fresh
 * clone fetches each absent one from its pinned release first (`sync-extension.mjs --if-missing`);
 * a tree that is present is left alone here and checked by `verifyExtensions` afterwards.
 */
export async function prepareExtensions({ from = at('extensions'), to = at('dist/ext'), fetchMissing = ensureExtension } = {}) {
  await rm(to, { recursive: true, force: true })
  await mkdir(to, { recursive: true })
  for (const id of await extensionIds(from)) {
    const tree = path.join(from, id)
    if (!(await readdir(tree).catch(() => null))?.length) {
      console.log(`extensions/${id}/ is absent; fetching the pinned release.`)
      await fetchMissing(id, { dir: from })
    }
    await cp(tree, path.join(to, id), { recursive: true })
  }
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
 * Throws unless every vendored extension matches its recorded release hashes
 * (`extensions/<id>.sha256.json`) both in `extensions/<id>/` and in its `dist/ext/<id>/` copy,
 * with no file missing, changed or added. Returns `{id: {path: sha256}}`.
 */
export async function verifyExtensions({ from = at('extensions'), to = at('dist/ext') } = {}) {
  const result = {}
  for (const id of await extensionIds(from)) {
    const recorded = await verifyExtension(id, { dir: from })
    const problems = compareHashes(recorded, await hashTree(path.join(to, id)))
    if (problems.length > 0) {
      throw Error(`Extension file changed in dist/ext/${id}/:\n  ${problems.slice(0, 20).join('\n  ')}`)
    }
    result[id] = recorded
    console.log(`Verified ${Object.keys(recorded).length} ${id} files byte-for-byte.`)
  }
  return result
}

/** Throws unless every `yomitan/` file and every vendored extension reached `dist/` byte for byte. */
export async function verify() {
  const original = await hashes(source)
  // `dist/ext/` is checked by verifyExtensions against its own record; hashing it here too would
  // only double the work.
  const copy = await hashes(dist, '', new Set(['ext']))
  for (const [name, hash] of Object.entries(original)) {
    if (copy[name] !== hash) throw Error(`Extension file changed: ${name}`)
  }
  console.log(`Verified ${Object.keys(original).length} Yomitan files byte-for-byte.`)
  const extensions = await verifyExtensions()
  return { yomitan: original, extensions }
}

/** Rebuilds `dist/` from scratch (wiping it, including any `dist/app/`), then verifies it. */
export async function prepare() {
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  await cp(source, dist, { recursive: true })
  await prepareHost()
  await prepareUi()
  await prepareExtensions()
  const { yomitan, extensions } = await verify()
  await writeFile(at('evidence/extension-sha256.json'), JSON.stringify(yomitan, null, 2) + '\n')
  // A sibling file, not new keys in the one above: that file stays a flat map of Yomitan's tree, so
  // its history only ever shows Yomitan changes, and each extension gets its own section here.
  await writeFile(at('evidence/extensions-sha256.json'), JSON.stringify(extensions, null, 2) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify')) await verify()
  else await prepare()
}
