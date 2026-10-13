/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain Node script, no TypeScript build. */
// Vendors a pinned upstream browser-extension release into `extensions/<id>/`, byte for byte.
//
//   node scripts/sync-extension.mjs <id>               download, verify and unpack into an empty dir
//   node scripts/sync-extension.mjs <id> --replace     the same, replacing an existing copy
//   node scripts/sync-extension.mjs <id> --verify      re-hash `extensions/<id>/` against the record
//   node scripts/sync-extension.mjs <id> --if-missing  download only if the tree is absent or stale
//   node scripts/sync-extension.mjs --all [...]        every pinned id instead of one
//
// Kimochi does not ship these trees: the app downloads the same pinned asset on demand and verifies
// it against the same records (src-tauri/src/extension_store.rs, EXTENSION_DOWNLOADS.md). The local
// copy here is a developer cache: the tests, the dev server and debug builds read it.
//
// The pin lives in `extensions/<id>.source.json` (upstream URL, version, tag, commit, the release
// asset's URL, sha256 and size). The unpacked file hashes are recorded in
// `extensions/<id>.sha256.json`, which the app compiles in and checks every downloaded file
// against. Beside them sit exact copies of the few files the build and the tests need without the
// tree (`<id>.manifest.json`, and any `fixtures` the pin names), each checked against the hash map.
// Only those records are committed: `extensions/<id>/` itself is gitignored (upstream bytes that
// would otherwise live in history for ever) and is refilled from the pinned release by
// `--if-missing`, which CI runs before `npm ci`. Nothing in the tree is ever post-processed:
// Kimochi adapts the extension from `host/`, never by editing it (DICTIONARY_ENGINES.md §7).
//
// The unzip is a small in-process reader (stored and deflate entries, through `node:zlib`) rather
// than a dependency or the system `unzip`, so it behaves the same on every OS and so its safety
// rules (no `..`, no absolute paths, no symlinks, CRC checked) are ours and are unit-tested.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

export const root = fileURLToPath(new URL('../', import.meta.url))
export const extensionsDir = path.join(root, 'extensions')

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/**
 * `{posixPath: sha256}` for every file under `dir`, keys sorted so the committed JSON is identical
 * on every OS (readdir order is filesystem-dependent).
 */
export async function hashTree(dir) {
  const result = {}
  const walk = async (prefix) => {
    for (const e of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
      const name = path.join(prefix, e.name)
      if (e.isDirectory()) await walk(name)
      else if (e.isFile()) result[name.split(path.sep).join('/')] = sha256(await readFile(path.join(dir, name)))
      // Anything else (a symlink) cannot have come from our unzip, so it is a local edit.
      else result[name.split(path.sep).join('/')] = 'not-a-regular-file'
    }
  }
  await walk('')
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Human-readable differences between two hash maps; empty when they match exactly. */
export function compareHashes(expected, actual) {
  const problems = []
  for (const [name, hash] of Object.entries(expected)) {
    if (!(name in actual)) problems.push(`missing: ${name}`)
    else if (actual[name] !== hash) problems.push(`changed: ${name}`)
  }
  for (const name of Object.keys(actual)) if (!(name in expected)) problems.push(`added: ${name}`)
  return problems
}

/**
 * The POSIX relative path a zip entry may be written to, or a thrown error. Rejects anything that
 * could land outside the target directory: absolute paths, drive letters, backslashes (a Windows
 * separator in disguise), `..` segments, and NUL bytes.
 */
export function safeEntryPath(name) {
  if (typeof name !== 'string' || name.length === 0) throw Error('Zip entry has an empty name')
  if (name.includes('\0')) throw Error(`Zip entry name contains NUL: ${JSON.stringify(name)}`)
  if (name.includes('\\')) throw Error(`Zip entry name contains a backslash: ${name}`)
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw Error(`Zip entry is absolute: ${name}`)
  const parts = name.split('/')
  if (parts.some((part) => part === '..')) throw Error(`Zip entry escapes the target: ${name}`)
  return parts.filter((part) => part !== '' && part !== '.').join('/')
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/**
 * Parses a zip's central directory into `{name, directory, data}` entries with `data` already
 * inflated and CRC-checked. Only what release zips use is supported (stored/deflate, no ZIP64, no
 * encryption); anything else is an error rather than a silently wrong tree.
 */
export function readZip(buffer) {
  // The end-of-central-directory record is in the last 22 + 65535 (max comment) bytes.
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw Error('Not a zip file (no end-of-central-directory record)')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || offset === 0xffffffff) throw Error('ZIP64 archives are not supported')
  const entries = []
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) throw Error('Corrupt zip central directory')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const madeBy = buffer.readUInt16LE(offset + 4) >> 8
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    if (flags & 0x1) throw Error(`Encrypted zip entry: ${rawName}`)
    // Unix "made by" (3) carries st_mode in the high 16 bits; 0o120000 is a symlink.
    const mode = madeBy === 3 ? externalAttributes >>> 16 : 0
    if ((mode & 0o170000) === 0o120000) throw Error(`Zip entry is a symlink: ${rawName}`)
    const name = safeEntryPath(rawName)
    const directory = rawName.endsWith('/')
    if (directory) {
      entries.push({ name, directory, data: null })
      continue
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL) throw Error(`Corrupt local header: ${rawName}`)
    const start =
      localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    const raw = buffer.subarray(start, start + compressedSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw Error(`Unsupported zip compression method ${method}: ${rawName}`)
    if (data.length !== size) throw Error(`Size mismatch for ${rawName}`)
    if (zlib.crc32(data) >>> 0 !== crc >>> 0) throw Error(`CRC mismatch for ${rawName}`)
    entries.push({ name, directory, data })
  }
  return entries
}

/**
 * Writes the zip's files under `dest`, removing `stripPrefix` (e.g. `"ext/"`) from every entry.
 * An entry outside the prefix is an error: the pin no longer describes the archive.
 */
export async function unzipTo(buffer, dest, { stripPrefix = '' } = {}) {
  const prefix = stripPrefix ? safeEntryPath(stripPrefix) + '/' : ''
  const written = []
  for (const entry of readZip(buffer)) {
    let name = entry.name
    if (prefix) {
      if (name + '/' === prefix) continue
      if (!name.startsWith(prefix)) throw Error(`Zip entry outside ${prefix}: ${name}`)
      name = name.slice(prefix.length)
    }
    if (name === '') continue
    const file = path.join(dest, ...name.split('/'))
    // Belt and braces on top of safeEntryPath: never write outside `dest`.
    if (!file.startsWith(path.resolve(dest) + path.sep)) throw Error(`Zip entry escapes the target: ${name}`)
    if (entry.directory) {
      await mkdir(file, { recursive: true })
      continue
    }
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, entry.data)
    written.push(name)
  }
  return written
}

/** The pin for `id`, validated enough that a typo fails here rather than mid-download. */
export async function loadSource(id, dir = extensionsDir) {
  if (!/^[a-z0-9-]+$/.test(id ?? '')) throw Error(`Invalid extension id: ${JSON.stringify(id)}`)
  const source = JSON.parse(await readFile(path.join(dir, `${id}.source.json`), 'utf8'))
  if (source.id !== id) throw Error(`${id}.source.json has id ${JSON.stringify(source.id)}`)
  if (!/^https:\/\//.test(source.asset?.url ?? '')) throw Error(`${id}.source.json: asset.url must be https`)
  if (!/^[0-9a-f]{64}$/.test(source.asset?.sha256 ?? '')) throw Error(`${id}.source.json: asset.sha256 is not a sha256`)
  if (!Number.isSafeInteger(source.asset?.size) || source.asset.size <= 0) throw Error(`${id}.source.json: asset.size must be the asset's size in bytes`)
  for (const [from, to] of Object.entries(source.fixtures ?? {})) {
    safeEntryPath(from)
    if (!new RegExp(`^${id}\\.[a-z0-9.-]+\\.json$`).test(to)) throw Error(`${id}.source.json: fixture ${from} must be copied to ${id}.<name>.json`)
  }
  return source
}

/**
 * `{path in the tree: record file name}` for the files kept beside the pin as exact copies: the
 * manifest (the host inlines it at build time, `host/ext/engines.js`) and the pin's `fixtures`.
 */
export const recordCopies = (source) => ({ 'manifest.json': `${source.id}.manifest.json`, ...(source.fixtures ?? {}) })

/** Writes the record copies from an unpacked tree. */
export async function writeRecordCopies(source, tree, dir = extensionsDir) {
  for (const [from, to] of Object.entries(recordCopies(source))) {
    await writeFile(path.join(dir, to), await readFile(path.join(tree, ...from.split('/'))))
  }
}

/** Problems with the record copies: each must hash to its entry in `<id>.sha256.json`. */
export async function checkRecordCopies(id, dir = extensionsDir) {
  const source = await loadSource(id, dir)
  const hashes = JSON.parse(await readFile(path.join(dir, `${id}.sha256.json`), 'utf8'))
  const problems = []
  for (const [from, to] of Object.entries(recordCopies(source))) {
    const bytes = await readFile(path.join(dir, to)).catch(() => null)
    if (!bytes) problems.push(`missing: ${to}`)
    else if (hashes[from] !== sha256(bytes)) problems.push(`${to} is not the release's ${from}`)
  }
  return problems
}

/** Every `extensions/*.source.json` id, sorted. */
export async function extensionIds(dir = extensionsDir) {
  const names = await readdir(dir).catch(() => [])
  return names.filter((name) => name.endsWith('.source.json')).map((name) => name.slice(0, -'.source.json'.length)).sort()
}

const isEmptyDir = async (dir) => {
  const info = await stat(dir).catch(() => null)
  if (!info) return true
  if (!info.isDirectory()) throw Error(`${dir} exists and is not a directory`)
  return (await readdir(dir)).length === 0
}

/** Download, verify, unpack and record `extensions/<id>/`. */
export async function syncExtension(id, { replace = false, dir = extensionsDir, log = console.log } = {}) {
  const source = await loadSource(id, dir)
  const target = path.join(dir, id)
  if (!replace && !(await isEmptyDir(target))) {
    throw Error(`extensions/${id}/ is not empty; pass --replace to overwrite it`)
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), `kimochi-sync-${id}-`))
  try {
    log(`Downloading ${source.asset.url}`)
    const response = await fetch(source.asset.url, { redirect: 'follow' })
    if (!response.ok) throw Error(`Download failed: HTTP ${response.status}`)
    const zip = Buffer.from(await response.arrayBuffer())
    if (zip.length !== source.asset.size) {
      throw Error(`size mismatch for ${source.asset.url}: expected ${source.asset.size} bytes, got ${zip.length}`)
    }
    await writeFile(path.join(temp, 'asset.zip'), zip)
    const actual = sha256(zip)
    if (actual !== source.asset.sha256) {
      throw Error(`sha256 mismatch for ${source.asset.url}\n  expected ${source.asset.sha256}\n  actual   ${actual}`)
    }
    // Unpack into the temp dir first so a bad entry never leaves a half-written extensions/<id>/.
    const staged = path.join(temp, 'tree')
    await unzipTo(zip, staged, source.unpack ?? {})
    const recorded = await hashTree(staged)
    if (!('manifest.json' in recorded)) throw Error('The unpacked release has no top-level manifest.json (check unpack.stripPrefix)')
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await unzipTo(zip, target, source.unpack ?? {})
    const written = await hashTree(target)
    const problems = compareHashes(recorded, written)
    if (problems.length > 0) throw Error(`Unpacked tree differs from staging:\n  ${problems.join('\n  ')}`)
    await writeFile(path.join(dir, `${id}.sha256.json`), JSON.stringify(written, null, 2) + '\n')
    await writeRecordCopies(source, target, dir)
    log(`Vendored ${source.name} ${source.version}: ${Object.keys(written).length} files in extensions/${id}/`)
    return written
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

/** Throws unless `tree` (default `extensions/<id>/`) matches `extensions/<id>.sha256.json` exactly. */
export async function verifyExtension(id, { dir = extensionsDir, tree = path.join(dir, id) } = {}) {
  const expected = JSON.parse(await readFile(path.join(dir, `${id}.sha256.json`), 'utf8'))
  const problems = compareHashes(expected, await hashTree(tree))
  if (problems.length > 0) {
    throw Error(`${path.relative(root, tree) || tree} does not match extensions/${id}.sha256.json:\n  ${problems.slice(0, 20).join('\n  ')}`)
  }
  return expected
}

/**
 * `extensions/<id>/` matches its record, or is replaced from the pinned release so that it does.
 * Returns `'verified'` when nothing was downloaded, `'synced'` otherwise. A stale tree (a pin bump
 * since it was fetched, a half-finished unpack) is replaced without asking: nothing under
 * `extensions/<id>/` is ever edited by hand (DICTIONARY_ENGINES.md §7), so there is nothing to keep.
 */
export async function ensureExtension(id, { dir = extensionsDir, log = console.log } = {}) {
  const current = await verifyExtension(id, { dir }).catch(() => null)
  if (current) {
    log(`extensions/${id}/ matches its record (${Object.keys(current).length} files); nothing to download.`)
    return 'verified'
  }
  await syncExtension(id, { dir, log, replace: true })
  return 'synced'
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const one = args.find((arg) => !arg.startsWith('--'))
  if (!one && !args.includes('--all')) {
    console.error('Usage: node scripts/sync-extension.mjs <id>|--all [--replace | --verify | --if-missing]')
    process.exit(2)
  }
  try {
    const ids = args.includes('--all') ? await extensionIds() : [one]
    for (const id of ids) {
      if (args.includes('--verify')) {
        const files = await verifyExtension(id)
        console.log(`Verified ${Object.keys(files).length} files in extensions/${id}/ byte-for-byte.`)
      } else if (args.includes('--if-missing')) await ensureExtension(id)
      else await syncExtension(id, { replace: args.includes('--replace') })
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
