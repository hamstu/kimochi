/* eslint @typescript-eslint/explicit-function-return-type: "off" -- This standalone spike runs plain JavaScript without a TypeScript build. */
// Builds `dist/`, the app origin: a byte-identical copy of `yomitan/`, plus `host/` as `dist/spike/`
// and `ui/` as `dist/ui/` (every `ui/*.ts` compiled to `.js`), then verifies the Yomitan copy.
//
//   node scripts/prepare.mjs           rebuild `dist/` from scratch, then verify
//   node scripts/prepare.mjs --verify  only verify `dist/` against `yomitan/`
//
// The per-directory steps are exported so the dev server (`scripts/dev-server.mjs`) can redo just
// the step a source change affects, without wiping `dist/` (and the React build beside it).
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

export const root = fileURLToPath(new URL('../', import.meta.url))
const at = (...parts) => path.join(root, ...parts)
export const dist = at('dist')
const source = at('yomitan')

async function hashes(dir, prefix = '') {
  const result = {}
  for (const e of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, e.name)
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

/** Throws unless every `yomitan/` file reached `dist/` byte for byte. */
export async function verify() {
  const original = await hashes(source)
  const copy = await hashes(dist)
  for (const [name, hash] of Object.entries(original)) {
    if (copy[name] !== hash) throw Error(`Extension file changed: ${name}`)
  }
  console.log(`Verified ${Object.keys(original).length} Yomitan files byte-for-byte.`)
  return original
}

/** Rebuilds `dist/` from scratch (wiping it, including any `dist/app/`), then verifies it. */
export async function prepare() {
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  await cp(source, dist, { recursive: true })
  await prepareHost()
  await prepareUi()
  const original = await verify()
  await writeFile(at('evidence/extension-sha256.json'), JSON.stringify(original, null, 2) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify')) await verify()
  else await prepare()
}
