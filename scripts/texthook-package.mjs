#!/usr/bin/env node
// Builds the Text Hooker download manifest (src-tauri/texthook-manifest.json) and the mirror
// package from pinned upstream releases. Neither hooker is ever bundled with Kimochi: the app
// downloads exactly the files listed in the manifest, checks each one's size and SHA-256, and
// tries each file's sources in order (the upstream GitHub release first, then our mirror).
//
// A GitHub source is the upstream release zip plus the entry inside it; the app reads only that
// entry with HTTP range requests, so it fetches a few MB rather than the whole 66 MB release. A
// mirror source is the bare file, uploaded from the tree this script writes under --out.
//
//   node scripts/texthook-package.mjs [--out <dir>] [--cache <dir>] [--check]
//
// --check rebuilds in memory and fails if the committed manifest differs (pins unchanged).
// Upload: copy <out>/texthook/ to the mirror's bucket root as is (nothing is uploaded here).
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { readZip, root } from './sync-extension.mjs'

/** Where the mirror serves `texthook/<engine>/<version>/<file>`. Not live yet (2026-11). */
export const MIRROR = 'https://downloads.kimochiapp.com/texthook'

/**
 * The pins. Every file of one engine comes from one upstream release, because the host, the
 * hook DLLs and their pipe protocol must match. `entry` is the path inside the release zip;
 * `url` instead names a file served on its own.
 */
export const ENGINES = {
  luna: {
    name: 'LunaHook',
    version: '12.1.3.8',
    project: 'https://github.com/HIllya51/LunaTranslator',
    license: 'GPL-3.0',
    zip: 'https://github.com/HIllya51/LunaTranslator/releases/download/v12.1.3.8/LunaTranslator_x64.zip',
    files: {
      // The host library the sidecar loads; it serves 32- and 64-bit games over per-process pipes.
      'LunaHost64.dll': { entry: 'LunaTranslator_x64/files/LunaHook/LunaHost64.dll' },
      // The DLLs injected into games.
      'LunaHook64.dll': { entry: 'LunaTranslator_x64/files/LunaHook/LunaHook64.dll' },
      'LunaHook32.dll': { entry: 'LunaTranslator_x64/files/LunaHook/LunaHook32.dll' },
      // LunaHost64.dll links the Visual C++ runtime, which not every PC has installed.
      'msvcp140.dll': { entry: 'LunaTranslator_x64/files/runtime3.13-64/msvcp140.dll' },
      'vcruntime140.dll': { entry: 'LunaTranslator_x64/files/runtime3.13-64/vcruntime140.dll' },
      'vcruntime140_1.dll': { entry: 'LunaTranslator_x64/files/runtime3.13-64/vcruntime140_1.dll' },
      'LICENSE.txt': { entry: 'LunaTranslator_x64/LICENSES/LICENSE.LunaTranslator' }
    }
  },
  textractor: {
    name: 'Textractor',
    version: '5.2.0',
    project: 'https://github.com/Artikash/Textractor',
    license: 'GPL-3.0',
    zip: 'https://github.com/Artikash/Textractor/releases/download/v5.2.0/Textractor-5.2.0-Zip-Version-English-Only.zip',
    files: {
      'x64/TextractorCLI.exe': { entry: 'Textractor/x64/TextractorCLI.exe' },
      'x64/texthook.dll': { entry: 'Textractor/x64/texthook.dll' },
      'x64/msvcp140.dll': { entry: 'Textractor/x64/msvcp140.dll' },
      'x64/vcruntime140.dll': { entry: 'Textractor/x64/vcruntime140.dll' },
      'x64/vcruntime140_1.dll': { entry: 'Textractor/x64/vcruntime140_1.dll' },
      'x86/TextractorCLI.exe': { entry: 'Textractor/x86/TextractorCLI.exe' },
      'x86/texthook.dll': { entry: 'Textractor/x86/texthook.dll' },
      'x86/msvcp140.dll': { entry: 'Textractor/x86/msvcp140.dll' },
      'x86/vcruntime140.dll': { entry: 'Textractor/x86/vcruntime140.dll' },
      'LICENSE.txt': { url: 'https://raw.githubusercontent.com/Artikash/Textractor/v5.2.0/LICENSE' }
    }
  }
}

export const manifestPath = path.join(root, 'src-tauri', 'texthook-manifest.json')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

async function fetchCached(url, cache) {
  const file = path.join(cache, sha256(url).slice(0, 16) + '-' + path.basename(new URL(url).pathname))
  if (existsSync(file)) return readFile(file)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw Error(`${url}: HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  await mkdir(cache, { recursive: true })
  await writeFile(file, data)
  return data
}

/** `{manifest, files: [{engine, version, name, data}]}` for the pins above. */
export async function build({ cache }) {
  const manifest = { engines: {} }
  const files = []
  for (const [id, engine] of Object.entries(ENGINES)) {
    const zip = new Map(readZip(await fetchCached(engine.zip, cache)).map((e) => [e.name, e]))
    const listed = []
    for (const [name, spec] of Object.entries(engine.files)) {
      let data
      const sources = []
      if (spec.entry) {
        const entry = zip.get(spec.entry)
        if (!entry || entry.directory) throw Error(`${engine.zip} has no ${spec.entry}`)
        data = entry.data
        sources.push({ url: engine.zip, zipEntry: spec.entry })
      } else {
        data = await fetchCached(spec.url, cache)
        sources.push({ url: spec.url })
      }
      sources.push({ url: `${MIRROR}/${id}/${engine.version}/${name}` })
      listed.push({ name, size: data.length, sha256: sha256(data), sources })
      files.push({ engine: id, version: engine.version, name, data })
    }
    manifest.engines[id] = {
      name: engine.name,
      version: engine.version,
      project: engine.project,
      license: engine.license,
      files: listed
    }
  }
  return { manifest, files }
}

const serialise = (manifest) => JSON.stringify(manifest, null, 2) + '\n'

async function main() {
  const args = process.argv.slice(2)
  const option = (name, fallback) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const cache = option('--cache', path.join(root, 'src-tauri', 'target', 'texthook-cache'))
  const out = option('--out', path.join(root, 'src-tauri', 'target', 'texthook-mirror'))
  const { manifest, files } = await build({ cache })
  if (args.includes('--check')) {
    const committed = await readFile(manifestPath, 'utf8')
    if (committed !== serialise(manifest))
      throw Error('texthook-manifest.json is out of date; run scripts/texthook-package.mjs')
    console.log('texthook-manifest.json matches the pins.')
    return
  }
  await writeFile(manifestPath, serialise(manifest))
  for (const file of files) {
    const dest = path.join(out, 'texthook', file.engine, file.version, ...file.name.split('/'))
    await mkdir(path.dirname(dest), { recursive: true })
    await writeFile(dest, file.data)
  }
  await writeFile(path.join(out, 'texthook', 'texthook-manifest.json'), serialise(manifest))
  const total = files.reduce((n, f) => n + f.data.length, 0)
  console.log(
    `Wrote ${path.relative(root, manifestPath)} and ${files.length} files (${(total / 1e6).toFixed(1)} MB) under ${out}/texthook/`
  )
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
