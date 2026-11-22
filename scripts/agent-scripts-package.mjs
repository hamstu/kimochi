#!/usr/bin/env node
// Builds src-tauri/agent-scripts.json: the pinned snapshot of the Agent scripts collection
// (https://github.com/0xDC00/scripts, MIT) that Kimochi's Agent engine downloads on demand, and
// the index the app matches games against before anything is downloaded.
//
// The app fetches the collection as GitHub's archive of the pinned commit. An archive's bytes are
// not promised to stay the same, so the pin is every file's size and SHA-256 instead: the app
// unpacks the archive and keeps it only if each file it needs matches (text_hook/agent/scripts.rs).
//
//   node scripts/agent-scripts-package.mjs [--commit <sha>] [--cache <dir>] [--check]
//
// --commit moves the pin (default: the one in the committed file). --check rebuilds in memory and
// fails if the committed file differs.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { readZip, root } from './sync-extension.mjs'

export const REPOSITORY = '0xDC00/scripts'
export const indexPath = path.join(root, 'src-tauri', 'agent-scripts.json')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

export const archiveUrls = (commit) => [
  `https://codeload.github.com/${REPOSITORY}/zip/${commit}`,
  `https://api.github.com/repos/${REPOSITORY}/zipball/${commit}`
]

/** The platform a script is for, from its file name's prefix. */
const PLATFORMS = {
  NS: 'switch',
  PSP: 'psp',
  PS2: 'ps2',
  PS3: 'ps3',
  PSVita: 'vita',
  '3DS': '3ds',
  PC: 'pc',
  PC98: 'pc98',
  Android: 'android'
}

/** Scripts that hook no one game (a loader, a generic engine hook): never offered by a match. */
const GENERIC = /^PC_(AIO|HCode|JavaScript_Tyrano\+)\.js$/i

/** The `// @key value` lines of a script's `==UserScript==` block. */
export function parseHeader(source) {
  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(source)?.[1] ?? ''
  const header = {}
  for (const line of block.split(/\r?\n/)) {
    const m = /^\s*\/\/\s*@(\w+)\s*(.*?)\s*$/.exec(line)
    if (m && !(m[1] in header)) header[m[1]] = m[2]
  }
  return { header, block }
}

/** A title id or disc serial, as the app compares them: upper case, letters and digits only. */
export const normaliseId = (id) => id.toUpperCase().replace(/[^0-9A-Z]/g, '')

/** What the index says about one game script, or null for a file that is not one. */
export function scriptEntry(name, source) {
  if (name.includes('/') || !name.endsWith('.js') || /^lib/i.test(name)) return null
  const prefix = name.split('_')[0]
  const platform = PLATFORMS[prefix]
  if (!platform) return null
  const { header, block } = parseHeader(source)
  if (!('name' in header)) return null
  const ids = new Set()
  // `[0100A3A00CC7E000] CLANNAD`, `[PCSG00291] Amagami`: the id in the name...
  const bracketed = /^\s*\[([^\]]+)\]\s*/.exec(header.name)
  if (bracketed) {
    for (const id of bracketed[1].split(/[,/\s]+/)) {
      // Multi-disc PSP serials such as ULJM06302-3 name both discs, not ULJM063023.
      const discs = /^([A-Z]{4}\d{4})(\d)-(\d)$/i.exec(id)
      if (discs && Number(discs[2]) <= Number(discs[3])) {
        for (let disc = Number(discs[2]); disc <= Number(discs[3]); disc++) ids.add(normaliseId(discs[1] + disc))
      } else if (/\d/.test(id)) ids.add(normaliseId(id))
    }
  }
  // ...and in the file name (`NS_<title id>_…`, `PS2_SLPM65732_…`).
  const second = name.split('_')[1] ?? ''
  if (platform === 'switch' && /^[0-9A-F]{16}$/i.test(second)) ids.add(second.toUpperCase())
  if (/^[A-Z]{4}\d{5}$/i.test(second)) ids.add(second.toUpperCase())
  const steam = [...new Set([...block.matchAll(/store\.steampowered\.com\/app\/(\d+)/g)].map((m) => Number(m[1])))]
  const title = (bracketed ? header.name.slice(bracketed[0].length) : header.name).trim() || name
  const stem = name.replace(/\.js$/, '')
  const lang = /_(JP|JPN|Japanese)$/i.test(stem)
    ? 'ja'
    : /_(EN|ENG|English)$/i.test(stem)
      ? 'en'
      : /_(CN|ZH|Chinese|TC|SC)$/i.test(stem)
        ? 'zh'
        : /_(KR|KO|Korean)$/i.test(stem)
          ? 'ko'
          : null
  return {
    file: name,
    title,
    platform,
    ...(ids.size ? { ids: [...ids].sort() } : {}),
    ...(steam.length ? { steam } : {}),
    ...(lang ? { lang } : {}),
    ...(header.version ? { version: header.version } : {}),
    ...(header.author ? { author: header.author.replace(/^\[|\]$/g, '') } : {}),
    ...(GENERIC.test(name) ? { generic: true } : {})
  }
}

async function fetchCached(url, cache) {
  const file = path.join(cache, sha256(url).slice(0, 16) + '.zip')
  if (existsSync(file)) return readFile(file)
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'kimochi-packager' } })
  if (!response.ok) throw Error(`${url}: HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  await mkdir(cache, { recursive: true })
  await writeFile(file, data)
  return data
}

/** The index for `commit`: every file's pin, and every game script's entry. */
export async function build({ commit, cache }) {
  const archive = await fetchCached(archiveUrls(commit)[0], cache)
  const entries = readZip(archive).filter((e) => !e.directory)
  // GitHub's archive puts everything under `<repo>-<commit>/`.
  const top = entries[0]?.name.split('/')[0] + '/'
  const files = []
  const scripts = []
  for (const entry of entries) {
    if (!entry.name.startsWith(top)) throw Error(`unexpected archive entry ${entry.name}`)
    const name = entry.name.slice(top.length)
    if (!name) continue
    files.push([name, entry.data.length, sha256(entry.data)])
    const script = scriptEntry(name, entry.data.toString('utf8'))
    if (script) scripts.push(script)
  }
  files.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  scripts.sort((a, b) => (a.file < b.file ? -1 : 1))
  return {
    repository: `https://github.com/${REPOSITORY}`,
    license: 'MIT',
    commit,
    archive: { urls: archiveUrls(commit), size: archive.length },
    files,
    scripts
  }
}

const serialise = (index) =>
  // One line per file and per script keeps diffs of a moved pin readable.
  '{\n' +
  Object.entries(index)
    .map(([key, value]) =>
      Array.isArray(value)
        ? `  ${JSON.stringify(key)}: [\n${value.map((v) => '    ' + JSON.stringify(v)).join(',\n')}\n  ]`
        : `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`
    )
    .join(',\n') +
  '\n}\n'

async function main() {
  const args = process.argv.slice(2)
  const option = (name, fallback) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const committed = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, 'utf8')) : null
  const commit = option('--commit', committed?.commit)
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw Error('Pass --commit <full sha> to pin the scripts.')
  const cache = option('--cache', path.join(root, 'src-tauri', 'target', 'agent-scripts-cache'))
  const index = await build({ commit, cache })
  if (args.includes('--check')) {
    if ((await readFile(indexPath, 'utf8')) !== serialise(index))
      throw Error('agent-scripts.json is out of date; run scripts/agent-scripts-package.mjs')
    console.log('agent-scripts.json matches the pin.')
    return
  }
  await writeFile(indexPath, serialise(index))
  console.log(
    `Wrote ${path.relative(root, indexPath)}: ${index.scripts.length} game scripts, ${index.files.length} files, commit ${commit.slice(0, 12)}`
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
