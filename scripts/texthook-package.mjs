#!/usr/bin/env node
// Builds the Text Hooker download manifest (src-tauri/texthook-manifest.json) and the mirror
// package from pinned upstream releases. Neither hooker is ever bundled with Kimochi: the app
// downloads exactly the files listed in the manifest, checks each one's size and SHA-256, and
// tries each file's sources (our mirror first, then the upstream GitHub release: download_mirror.rs
// orders them).
//
// A GitHub source is the upstream release zip plus the entry inside it; the app reads only that
// entry with HTTP range requests, so it fetches a few MB rather than the whole 66 MB release. A
// mirror source is the bare file, uploaded from the tree this script writes under --out.
//
//   node scripts/texthook-package.mjs [--out <dir>] [--cache <dir>] [--check]
//
// --check rebuilds in memory and fails if the committed manifest differs (pins unchanged).
// Upload: .github/workflows/download-mirror.yml copies each file to the mirror (DOWNLOADS_MIRROR.md).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { readZip, root } from './sync-extension.mjs'

/** Where the mirror serves `texthook/<engine>/<version>/<file>` (live since 2026-11-17). */
export const MIRROR = 'https://downloads.kimochiapp.com/texthook'

/**
 * The pins. Every file of one engine comes from one upstream release, because the host, the
 * hook DLLs and their pipe protocol must match. `entry` is the path inside the release zip;
 * `url` instead names a file served on its own.
 */
/** The Frida release the Agent engine injects with (17: the first with Windows ARM64 builds). */
export const FRIDA = '17.27.4'
/** The one that runs inside Wine (the last 16; the Agent scripts' API, no shim needed). */
export const FRIDA_WINE = '16.7.19'
const FRIDA_RELEASE = `https://github.com/frida/frida/releases/download/${FRIDA}`
const FRIDA_LICENSE = `https://raw.githubusercontent.com/frida/frida/${FRIDA}/COPYING`

export const ENGINES = {
  'agent-gadget-macos': {
    name: 'Agent launch',
    version: FRIDA,
    project: 'https://github.com/frida/frida',
    license: 'wxWindows Library Licence 3.1',
    files: {
      'Gadget.dylib': { xz: `${FRIDA_RELEASE}/frida-gadget-${FRIDA}-macos-universal.dylib.xz` },
      'LICENSE.txt': { url: FRIDA_LICENSE }
    }
  },
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
  },
  // The Agent engine's injector (text_hook/agent): Frida's frida-inject, one build per Windows CPU.
  // Each injects into 32- and 64-bit games (and, on ARM64, into x64 games run by emulation); under
  // Wine the x64 build runs inside the game's prefix. Frida ships it xz-compressed only, so the
  // pin also names the compressed file, which the mirror keeps as it is.
  'agent-x64': {
    name: 'Agent',
    version: FRIDA,
    project: 'https://github.com/frida/frida',
    license: 'wxWindows Library Licence 3.1',
    files: {
      'frida-inject.exe': { xz: `${FRIDA_RELEASE}/frida-inject-${FRIDA}-windows-x86_64.exe.xz` },
      'LICENSE.txt': { url: FRIDA_LICENSE }
    }
  },
  'agent-macos-arm64': {
    name: 'Agent',
    version: FRIDA,
    project: 'https://github.com/frida/frida',
    license: 'wxWindows Library Licence 3.1',
    files: {
      'frida-inject': { xz: `${FRIDA_RELEASE}/frida-inject-${FRIDA}-macos-arm64.xz` },
      'LICENSE.txt': { url: FRIDA_LICENSE }
    }
  },
  'agent-arm64': {
    name: 'Agent',
    version: FRIDA,
    project: 'https://github.com/frida/frida',
    license: 'wxWindows Library Licence 3.1',
    files: {
      'frida-inject.exe': { xz: `${FRIDA_RELEASE}/frida-inject-${FRIDA}-windows-arm64.exe.xz` },
      'LICENSE.txt': { url: FRIDA_LICENSE }
    }
  },
  // Inside a Wine or Proton prefix (Linux): Frida 17 cannot start there ("Unable to locate the
  // ntdll loader TLS routines"), 16 can.
  'agent-wine': {
    name: 'Agent',
    version: FRIDA_WINE,
    project: 'https://github.com/frida/frida',
    license: 'wxWindows Library Licence 3.1',
    files: {
      'frida-inject.exe': {
        xz: `https://github.com/frida/frida/releases/download/${FRIDA_WINE}/frida-inject-${FRIDA_WINE}-windows-x86_64.exe.xz`
      },
      'LICENSE.txt': { url: `https://raw.githubusercontent.com/frida/frida/${FRIDA_WINE}/COPYING` }
    }
  }
}

export const manifestPath = path.join(root, 'src-tauri', 'texthook-manifest.json')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** An xz stream's contents, by the `xz` tool (Git for Windows, Linux and Homebrew have it). */
function unxz(packed) {
  const result = spawnSync('xz', ['-dc'], { input: packed, maxBuffer: 1 << 30 })
  if (result.error || result.status !== 0)
    throw Error(`xz could not unpack a pinned file: ${result.error?.message ?? result.stderr}`)
  return result.stdout
}

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
    const zip = engine.zip ? new Map(readZip(await fetchCached(engine.zip, cache)).map((e) => [e.name, e])) : new Map()
    const listed = []
    for (const [name, spec] of Object.entries(engine.files)) {
      let data
      let packed = null
      const sources = []
      if (spec.xz) {
        packed = await fetchCached(spec.xz, cache)
        data = unxz(packed)
        sources.push({ url: spec.xz, xz: true })
      } else if (spec.entry) {
        const entry = zip.get(spec.entry)
        if (!entry || entry.directory) throw Error(`${engine.zip} has no ${spec.entry}`)
        data = entry.data
        sources.push({ url: engine.zip, zipEntry: spec.entry })
      } else {
        data = await fetchCached(spec.url, cache)
        sources.push({ url: spec.url })
      }
      // A compressed pin is mirrored compressed: the app unpacks it, whichever host it came from.
      if (packed) sources.push({ url: `${MIRROR}/${id}/${engine.version}/${name}.xz`, xz: true })
      else sources.push({ url: `${MIRROR}/${id}/${engine.version}/${name}` })
      listed.push({
        name,
        size: data.length,
        sha256: sha256(data),
        ...(packed ? { xz: { size: packed.length, sha256: sha256(packed) } } : {}),
        sources
      })
      files.push({ engine: id, version: engine.version, name: packed ? `${name}.xz` : name, data: packed ?? data })
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
