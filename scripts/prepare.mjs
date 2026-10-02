/* eslint @typescript-eslint/explicit-function-return-type: "off" -- This standalone spike runs plain JavaScript without a TypeScript build. */
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const source = path.resolve(root, 'yomitan')
async function hashes(dir, prefix = '') {
  const result = {}
  for (const e of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, e.name)
    if (e.isDirectory()) Object.assign(result, await hashes(dir, name))
    else
      result[name] = createHash('sha256')
        .update(await readFile(path.join(dir, name)))
        .digest('hex')
  }
  return result
}
const original = await hashes(source)
if (!process.argv.includes('--verify')) {
  await rm('dist', { recursive: true, force: true })
  await mkdir('dist', { recursive: true })
  await cp(source, 'dist', { recursive: true })
  await cp('host', 'dist/spike', { recursive: true })
  await cp('ui', 'dist/ui', { recursive: true })
  // Every `ui/*.ts` module compiles to `dist/ui/*.js`. Globbed rather than listed so the overlay
  // workstream can add modules without touching this script.
  const typescriptModules = (await readdir('ui')).filter((name) => name.endsWith('.ts'))
  for (const name of typescriptModules) {
    await build({
      entryPoints: [path.join('ui', name)],
      outfile: path.join('dist/ui', name.replace(/\.ts$/, '.js')),
      format: 'esm',
      target: 'safari17'
    })
  }
  await build({
    entryPoints: ['host/network-entry.js'],
    outfile: 'dist/spike/network-bundle.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'safari17'
  })
  await writeFile('evidence/extension-sha256.json', JSON.stringify(original, null, 2) + '\n')

  // Every module in dist/ui is loaded straight from the app origin with no bundler or import map,
  // so a bare or extensionless specifier is a runtime failure that no frontend build would catch.
  const unresolved = []
  for (const name of (await readdir('dist/ui')).filter((file) => file.endsWith('.js'))) {
    const source = await readFile(path.join('dist/ui', name), 'utf8')
    for (const match of source.matchAll(
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
const copy = await hashes('dist')
for (const [name, hash] of Object.entries(original)) {
  if (copy[name] !== hash) throw Error(`Extension file changed: ${name}`)
}
console.log(`Verified ${Object.keys(original).length} Yomitan files byte-for-byte.`)
