#!/usr/bin/env node
// Kimochi's download mirror, https://downloads.kimochiapp.com (a Cloudflare R2 bucket). The app
// asks it first for every pinned download and falls back to upstream (src-tauri/src/download_mirror.rs);
// this script fills it. DOWNLOADS_MIRROR.md has the layout, the retention policy and the setup.
//
//   node scripts/download-mirror.mjs inventory [--releases-months X]
//       Lists what should be on the mirror: every file pinned by this checkout (the dictionary
//       engines, the OCR and speech models, the text hookers, the Yomitan API helper), plus every
//       file pinned by a `v*` release tagged in the last X months, so the versions those releases
//       download stay mirrored too.
//
//   node scripts/download-mirror.mjs sync [--backend s3|wrangler|dry-run] [--prune]
//       [--keep-versions N] [--keep-months X]
//       Uploads every inventoried file the mirror lacks: downloaded from upstream (a zip entry is
//       read out of its release zip), checked against its pinned SHA-256 (and size), then stored
//       under an immutable path. Records each file in the bucket's ledger, `index/mirror.json`.
//       With --prune, deletes what the retention policy no longer keeps (see `retention`).
//
//   node scripts/download-mirror.mjs release --tag vX.Y.Z --dir <assets> --manifest <latest.json>
//       [--backend …]
//       The app's own release: uploads every file in --dir to `app/<tag>/`, checks that each URL
//       the mirror's manifest names now answers with the right size, and only then uploads the
//       manifest as `app/latest.json` (the endpoint the app asks first).
//
// Backends: `s3` (CI) is R2's S3 API through the AWS CLI, with R2_ACCESS_KEY_ID and
// R2_SECRET_ACCESS_KEY (an R2 API token scoped to the bucket) and R2_ACCOUNT_ID; `wrangler` is
// `wrangler r2 object put` with the logged-in account (local seeding; objects up to 300 MB);
// `dry-run` (the default without R2 credentials) uploads nothing. Node built-ins only, apart from
// the AWS CLI or wrangler.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip } from './sync-extension.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

export const MIRROR = 'https://downloads.kimochiapp.com'
export const BUCKET = 'kimochi-downloads'
/** The Cloudflare account that owns kimochiapp.com and the bucket (not a secret). */
export const ACCOUNT_ID = '89370b17100354f9a9d4dd0abb8c054a'
/** Upstream hosts whose pinned files are mirrored; `MIRRORED_HOSTS` in download_mirror.rs. */
export const MIRRORED_HOSTS = ['github.com', 'huggingface.co', 'raw.githubusercontent.com']
export const LEDGER = 'index/mirror.json'
export const IMMUTABLE = 'public, max-age=31536000, immutable'
/** The update manifest changes with every release; caches must let a new one through quickly. */
export const MANIFEST_CACHE = 'public, max-age=60, must-revalidate'
/** Retention defaults: generous on purpose (storage is cheap; a missing file costs a fallback). */
export const KEEP_VERSIONS = 5
export const KEEP_MONTHS = 12

const IDENTITY = { 'accept-encoding': 'identity' }
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const isSha256 = (hash) => /^[0-9a-f]{64}$/.test(hash ?? '')

export function hostOf(url) {
  const rest = url.includes('://') ? url.slice(url.indexOf('://') + 3) : url
  return rest.split(/[/?#]/)[0]
}

/** The mirror's file name for an upstream URL; `file_name` in download_mirror.rs. */
export function fileName(url) {
  const last = url.split(/[?#]/)[0].split('/').pop() ?? ''
  const name = [...last].map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : '_')).join('')
  return name === '' || /^\.+$/.test(name) ? 'file' : name
}

/** `files/sha256/<sha256>/<file name>`, or null when the file is not mirrored; `mirror_path`. */
export function mirrorPath(url, hash) {
  if (!url.startsWith('https://') || !isSha256(hash) || !MIRRORED_HOSTS.includes(hostOf(url))) return null
  return `files/sha256/${hash}/${fileName(url)}`
}

// ---------------------------------------------------------------------------- inventory

/** Reads this checkout's files. */
export const worktree = {
  name: 'HEAD (worktree)',
  async read(rel) {
    const file = path.join(root, rel)
    return existsSync(file) ? readFile(file, 'utf8') : null
  },
  async list(dir) {
    const full = path.join(root, dir)
    return existsSync(full) ? (await readdir(full)).map((name) => `${dir}/${name}`) : []
  }
}

const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : null
}

/** Reads the files of a git ref (a release tag). */
export const atRef = (ref) => ({
  name: ref,
  async read(rel) {
    return git('show', `${ref}:${rel}`)
  },
  async list(dir) {
    return (git('ls-tree', '--name-only', `${ref}:${dir}`) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((name) => `${dir}/${name}`)
  }
})

const parse = (text, what) => {
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${what}: ${e.message}`)
  }
}

/**
 * Every mirrored file a tree pins, as `{path, artifact, version, url, zipEntry?, sha256, size}`
 * (`size` null when the pin has none). `artifact` groups the versions of one thing for retention.
 */
export async function pinnedFiles(tree) {
  const out = []
  const add = (entry) => entry.path && out.push(entry)

  // Dictionary engines: extensions/<id>.source.json.
  for (const file of (await tree.list('extensions')).filter((f) => f.endsWith('.source.json'))) {
    const pin = parse(await tree.read(file), file)
    if (!pin.asset?.url) continue
    add({
      path: mirrorPath(pin.asset.url, pin.asset.sha256),
      artifact: `extensions/${pin.id}`,
      version: pin.version,
      url: pin.asset.url,
      sha256: pin.asset.sha256,
      size: pin.asset.size ?? null
    })
  }

  // OCR and speech models: src-tauri/ocr-models.json.
  const models = await tree.read('src-tauri/ocr-models.json')
  if (models) {
    for (const [engine, spec] of Object.entries(parse(models, 'ocr-models.json').engines ?? {})) {
      for (const file of spec.files ?? []) {
        add({
          path: mirrorPath(file.url, file.sha256),
          artifact: `models/${engine}/${file.name}`,
          version: file.revision || file.sha256.slice(0, 12),
          url: file.url,
          sha256: file.sha256,
          size: file.size ?? null
        })
      }
    }
  }

  // Text hookers: src-tauri/texthook-manifest.json names its mirror path explicitly.
  const hooks = await tree.read('src-tauri/texthook-manifest.json')
  if (hooks) {
    for (const [id, engine] of Object.entries(parse(hooks, 'texthook-manifest.json').engines ?? {})) {
      for (const file of engine.files ?? []) {
        const mirror = file.sources.find((s) => s.url.startsWith(`${MIRROR}/`) && !s.zipEntry)
        const upstream = file.sources.find((s) => !s.url.startsWith(`${MIRROR}/`))
        if (!mirror || !upstream) continue
        add({
          path: mirror.url.slice(MIRROR.length + 1),
          artifact: `texthook/${id}/${file.name}`,
          version: engine.version,
          url: upstream.url,
          ...(upstream.zipEntry ? { zipEntry: upstream.zipEntry } : {}),
          sha256: file.sha256,
          size: file.size
        })
      }
    }
  }

  // The Yomitan API helper: pinned in reader/yomitan_install.rs.
  const helper = await tree.read('src-tauri/src/reader/yomitan_install.rs')
  if (helper) {
    const release = /const RELEASE_URL: &str = "([^"]+)"/.exec(helper)?.[1]
    const version = /pub const HOST_VERSION: &str = "([^"]+)"/.exec(helper)?.[1]
    if (release && version) {
      for (const [, asset, hash] of helper.matchAll(/\("(yomitan-host-[\w.-]+)",\s*"([0-9a-f]{64})"\)/g)) {
        const url = `${release}/${version}/${asset}`
        add({ path: mirrorPath(url, hash), artifact: `yomitan-host/${asset}`, version, url, sha256: hash, size: null })
      }
    }
  }
  return out
}

/** The `v*` release tags created in the last `months` months, newest first. */
export function recentReleases(months, now = new Date()) {
  const since = new Date(now)
  since.setUTCMonth(since.getUTCMonth() - months)
  return (
    git('for-each-ref', '--sort=-creatordate', '--format=%(refname:short) %(creatordate:iso-strict)', 'refs/tags/v*') ??
    ''
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tag, date] = line.split(' ')
      return { tag, date: new Date(date) }
    })
    .filter(({ date }) => date >= since)
}

/** This checkout's pins plus those of the recent releases, one entry per mirror path. */
export async function inventory({ releasesMonths = KEEP_MONTHS, log = () => {} } = {}) {
  const trees = [worktree, ...recentReleases(releasesMonths).map(({ tag }) => atRef(tag))]
  const byPath = new Map()
  for (const tree of trees) {
    for (const entry of await pinnedFiles(tree)) {
      const seen = byPath.get(entry.path)
      if (seen && seen.sha256 !== entry.sha256) {
        throw new Error(`${entry.path}: pinned with two hashes (${seen.from} and ${tree.name})`)
      }
      if (!seen) byPath.set(entry.path, { ...entry, from: tree.name })
    }
    log(`${tree.name}: ${byPath.size} files so far`)
  }
  return [...byPath.values()]
}

// ---------------------------------------------------------------------------- datasets

/**
 * Data the app downloads at its newest upstream release rather than a pinned one (no hash in the
 * app to check, as with GitHub itself). Each sync copies upstream's latest release asset to
 * `data/<id>/<tag>/<asset>` (immutable; checked against GitHub's own SHA-256 digest), and points
 * `data/<id>/latest/<asset>` and `data/<id>/latest.json` (`{tag, sha256, size, path}`) at it. Other
 * datasets (the Luna hook database, …) go under `data/<id>/` the same way.
 */
export const DATASETS = [{ id: 'jitendex', repo: 'stephenmk/stephenmk.github.io', asset: 'jitendex-yomitan.zip' }]
const LATEST_CACHE = 'public, max-age=3600'

async function latestRelease({ repo, asset }) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'Kimochi download mirror (CI)' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers })
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${repo}'s latest release`)
  const release = await response.json()
  const found = release.assets?.find((a) => a.name === asset)
  if (!found) throw new Error(`${repo} ${release.tag_name} has no ${asset}`)
  const sha = /^sha256:([0-9a-f]{64})$/.exec(found.digest ?? '')?.[1]
  if (!sha) throw new Error(`${repo} ${release.tag_name}: GitHub gives no SHA-256 for ${asset}`)
  return { tag: release.tag_name, url: found.browser_download_url, sha256: sha, size: found.size }
}

/** Mirrors each dataset's latest release; returns the inventory entries it now references. */
async function syncDatasets(store, ledger, now, failures) {
  const current = []
  for (const dataset of DATASETS) {
    try {
      const latest = await latestRelease(dataset)
      if (!/^[\w.-]+$/.test(latest.tag)) throw new Error(`unexpected tag ${latest.tag}`)
      const entry = {
        path: `data/${dataset.id}/${latest.tag}/${dataset.asset}`,
        artifact: `data/${dataset.id}`,
        version: latest.tag,
        url: latest.url,
        sha256: latest.sha256,
        size: latest.size
      }
      let data = null
      if (!(await present(entry))) {
        data = await fetchPinned(entry)
        await putBytes(store, entry.path, data, { contentType: contentType(entry.path), cacheControl: IMMUTABLE })
        console.log(`uploaded ${entry.artifact} ${entry.version} → ${entry.path}`)
      }
      const pointer = {
        tag: latest.tag,
        sha256: latest.sha256,
        size: latest.size,
        path: entry.path,
        upstream: latest.url
      }
      if (
        ledger.datasets?.[dataset.id]?.tag !== latest.tag ||
        !(await present({ path: `data/${dataset.id}/latest/${dataset.asset}`, size: latest.size }))
      ) {
        data ??= await fetchPinned(entry)
        const options = { contentType: contentType(dataset.asset), cacheControl: LATEST_CACHE }
        await putBytes(store, `data/${dataset.id}/latest/${dataset.asset}`, data, options)
        await putBytes(store, `data/${dataset.id}/latest.json`, JSON.stringify(pointer, null, 2) + '\n', {
          ...options,
          contentType: 'application/json'
        })
        console.log(`latest   ${entry.artifact} → ${latest.tag}`)
      } else {
        console.log(`ok       ${entry.artifact} ${latest.tag}`)
      }
      ledger.datasets = { ...ledger.datasets, [dataset.id]: pointer }
      const known = ledger.entries[entry.path]
      ledger.entries[entry.path] = {
        artifact: entry.artifact,
        version: entry.version,
        sha256: entry.sha256,
        size: entry.size,
        upstream: entry.url,
        prunable: true,
        firstSeen: known?.firstSeen ?? now.toISOString(),
        lastReferenced: now.toISOString()
      }
      current.push(entry)
    } catch (e) {
      failures.push(`data/${dataset.id}: ${e.message}`)
      console.error(`FAILED   data/${dataset.id}: ${e.message}`)
    }
  }
  return current
}

// ---------------------------------------------------------------------------- retention

/**
 * Which ledger entries may be deleted. An entry is kept when any of these holds:
 * - it is in the current inventory (pinned now, or by a release of the last `keepMonths` months);
 * - it is among the `keepVersions` most recently referenced versions of its artifact;
 * - it was last referenced less than `keepMonths` months ago.
 * Only entries under `files/` and `texthook/`, and dataset releases the sync marked `prunable`, are
 * ever deleted (never `app/`, a dataset's `latest`, or another tool's `data/`).
 */
export function retention(
  ledger,
  current,
  { keepVersions = KEEP_VERSIONS, keepMonths = KEEP_MONTHS, now = new Date() } = {}
) {
  const since = new Date(now)
  since.setUTCMonth(since.getUTCMonth() - keepMonths)
  const pinned = new Set(current.map((e) => e.path))
  const byArtifact = new Map()
  for (const [p, entry] of Object.entries(ledger.entries ?? {})) {
    const list = byArtifact.get(entry.artifact) ?? []
    list.push({ path: p, ...entry })
    byArtifact.set(entry.artifact, list)
  }
  const doomed = []
  for (const list of byArtifact.values()) {
    list.sort(
      (a, b) =>
        (b.lastReferenced ?? '').localeCompare(a.lastReferenced ?? '') ||
        (b.firstSeen ?? '').localeCompare(a.firstSeen ?? '')
    )
    list.forEach((entry, rank) => {
      const deletable =
        /^(files|texthook)\//.test(entry.path) || (entry.prunable === true && !/\/latest[/.]/.test(entry.path))
      const recent = entry.lastReferenced && new Date(entry.lastReferenced) >= since
      if (deletable && !pinned.has(entry.path) && rank >= keepVersions && !recent) doomed.push(entry.path)
    })
  }
  return doomed.sort()
}

// ---------------------------------------------------------------------------- transfer

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Kimochi download mirror (CI)' } })
  if (!response.ok) throw new Error(`${hostOf(url)} answered HTTP ${response.status} for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Whether the mirror already serves `entry` (by size when the pin has one). */
async function present(entry) {
  // Uncompressed, so Content-Length is the stored size (Cloudflare gzips text on request).
  const response = await fetch(`${MIRROR}/${entry.path}`, { method: 'HEAD', headers: IDENTITY })
  if (!response.ok) return false
  const length = Number(response.headers.get('content-length'))
  return entry.size == null || length === entry.size
}

const zips = new Map()
/** The pinned bytes, from upstream; throws unless they match the pin. */
export async function fetchPinned(entry) {
  let data
  if (entry.zipEntry) {
    if (!zips.has(entry.url)) zips.set(entry.url, new Map(readZip(await download(entry.url)).map((e) => [e.name, e])))
    data = zips.get(entry.url).get(entry.zipEntry)?.data
    if (!data) throw new Error(`${entry.url} has no ${entry.zipEntry}`)
  } else {
    data = await download(entry.url)
  }
  if (entry.size != null && data.length !== entry.size) {
    throw new Error(`${entry.url}: ${data.length} bytes, pinned ${entry.size}`)
  }
  const actual = sha256(data)
  if (actual !== entry.sha256) throw new Error(`${entry.url}: SHA-256 ${actual}, pinned ${entry.sha256}`)
  return data
}

const contentType = (name) =>
  ({
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
    '.yml': 'text/yaml; charset=utf-8',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.sig': 'text/plain; charset=utf-8',
    '.exe': 'application/vnd.microsoft.portable-executable',
    '.dll': 'application/vnd.microsoft.portable-executable',
    '.deb': 'application/vnd.debian.binary-package'
  })[path.extname(name).toLowerCase()] ?? 'application/octet-stream'

function run(command, args, env) {
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) throw new Error(`${command} ${args[0]} … failed (exit ${result.status})`)
  return result.stdout
}

/** `{put(key, file, {contentType, cacheControl}), remove(key)}` for a backend name. */
export function backend(name) {
  if (name === 'dry-run') {
    return {
      name,
      put: async (key) => console.log(`  (dry run) would upload ${key}`),
      remove: async (key) => console.log(`  (dry run) would delete ${key}`)
    }
  }
  if (name === 's3') {
    for (const v of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])
      if (!process.env[v]) throw new Error(`${v} is not set`)
    const account = process.env.R2_ACCOUNT_ID || ACCOUNT_ID
    const env = {
      AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      AWS_DEFAULT_REGION: 'auto',
      AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
      AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required'
    }
    const endpoint = ['--endpoint-url', `https://${account}.r2.cloudflarestorage.com`]
    return {
      name,
      async put(key, file, { contentType: type, cacheControl }) {
        // `s3 cp` does multipart for large files (the 444 MB manga model).
        run(
          'aws',
          [
            's3',
            'cp',
            file,
            `s3://${BUCKET}/${key}`,
            '--content-type',
            type,
            '--cache-control',
            cacheControl,
            '--only-show-errors',
            ...endpoint
          ],
          env
        )
      },
      async remove(key) {
        run('aws', ['s3', 'rm', `s3://${BUCKET}/${key}`, '--only-show-errors', ...endpoint], env)
      }
    }
  }
  if (name === 'wrangler') {
    const env = { CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || ACCOUNT_ID }
    const wrangler = (...args) => run('npx', ['--yes', 'wrangler', 'r2', 'object', ...args, '--remote'], env)
    return {
      name,
      async put(key, file, { contentType: type, cacheControl }) {
        if ((await stat(file)).size > 300 * 1024 * 1024)
          throw new Error(`${key}: over wrangler's 300 MB limit; use the s3 backend (CI)`)
        wrangler('put', `${BUCKET}/${key}`, '--file', file, '--content-type', type, '--cache-control', cacheControl)
      },
      async remove(key) {
        wrangler('delete', `${BUCKET}/${key}`)
      }
    }
  }
  throw new Error(`unknown backend: ${name}`)
}

async function putBytes(store, key, data, options) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kimochi-mirror-'))
  try {
    const file = path.join(dir, path.basename(key))
    await writeFile(file, data)
    await store.put(key, file, options)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function readLedger() {
  const response = await fetch(`${MIRROR}/${LEDGER}`, { cache: 'no-store' })
  if (response.status === 404) return { version: 1, entries: {} }
  if (!response.ok) throw new Error(`could not read the ledger: HTTP ${response.status}`)
  return response.json()
}

async function sync(options) {
  const store = backend(options.backend)
  const keepVersions = Number(options['keep-versions'] ?? process.env.MIRROR_KEEP_VERSIONS ?? KEEP_VERSIONS)
  const keepMonths = Number(options['keep-months'] ?? process.env.MIRROR_KEEP_MONTHS ?? KEEP_MONTHS)
  const now = new Date()
  const entries = await inventory({ releasesMonths: keepMonths, log: console.log })
  const ledger = await readLedger()
  const failures = []
  let uploaded = 0
  for (const entry of entries) {
    const label = `${entry.artifact} ${entry.version}`
    try {
      if (await present(entry)) {
        console.log(`ok       ${label}`)
      } else if (store.name === 'dry-run') {
        console.log(`missing  ${label} → ${entry.path}`)
      } else {
        const data = await fetchPinned(entry)
        await putBytes(store, entry.path, data, { contentType: contentType(entry.path), cacheControl: IMMUTABLE })
        uploaded++
        console.log(`uploaded ${label} → ${entry.path} (${data.length} bytes)`)
      }
      const known = ledger.entries[entry.path]
      ledger.entries[entry.path] = {
        artifact: entry.artifact,
        version: entry.version,
        sha256: entry.sha256,
        size: entry.size,
        upstream: entry.url,
        firstSeen: known?.firstSeen ?? now.toISOString(),
        lastReferenced: now.toISOString()
      }
    } catch (e) {
      failures.push(`${label}: ${e.message}`)
      console.error(`FAILED   ${label}: ${e.message}`)
    }
  }
  const datasets = await syncDatasets(store, ledger, now, failures)
  const doomed = retention(ledger, [...entries, ...datasets], { keepVersions, keepMonths, now })
  if (doomed.length)
    console.log(`retention (keep ${keepVersions} versions, ${keepMonths} months): ${doomed.length} to delete`)
  for (const key of doomed) {
    if (options.prune) {
      await store.remove(key)
      delete ledger.entries[key]
      console.log(`deleted  ${key}`)
    } else {
      console.log(`would delete ${key} (pass --prune)`)
    }
  }
  ledger.updated = now.toISOString()
  ledger.policy = { keepVersions, keepMonths }
  await putBytes(store, LEDGER, JSON.stringify(ledger, null, 2) + '\n', {
    contentType: 'application/json',
    cacheControl: 'no-store'
  })
  console.log(`${entries.length} files pinned, ${uploaded} uploaded, ${failures.length} failed (${store.name})`)
  if (failures.length) {
    throw new Error(`${failures.length} file(s) could not be mirrored:\n${failures.join('\n')}`)
  }
}

async function release(options) {
  for (const name of ['tag', 'dir', 'manifest']) if (!options[name]) throw new Error(`--${name} is required`)
  if (!/^v\d+\.\d+\.\d+$/.test(options.tag)) throw new Error(`not a release tag: ${options.tag}`)
  const store = backend(options.backend)
  const prefix = `app/${options.tag}`
  const names = (await readdir(options.dir)).filter((name) => !name.startsWith('.')).sort()
  if (names.length === 0) throw new Error(`${options.dir} is empty`)
  for (const name of names) {
    await store.put(`${prefix}/${name}`, path.join(options.dir, name), {
      contentType: contentType(name),
      cacheControl: IMMUTABLE
    })
    console.log(`uploaded ${prefix}/${name}`)
  }
  const manifest = parse(await readFile(options.manifest, 'utf8'), options.manifest)
  if (store.name !== 'dry-run') {
    // Every bundle the manifest offers must be there before the manifest is.
    for (const [key, entry] of Object.entries(manifest.platforms)) {
      if (!entry.url.startsWith(`${MIRROR}/${prefix}/`)) throw new Error(`${key}: ${entry.url} is not under ${prefix}`)
      const response = await fetch(entry.url, { method: 'HEAD', cache: 'no-store', headers: IDENTITY })
      const length = Number(response.headers.get('content-length'))
      if (!response.ok || (entry.size && length !== entry.size)) {
        throw new Error(
          `${key}: ${entry.url} answered HTTP ${response.status} (${length} bytes); not publishing the manifest`
        )
      }
    }
  }
  await store.put('app/latest.json', options.manifest, {
    contentType: 'application/json',
    cacheControl: MANIFEST_CACHE
  })
  console.log(`published ${MIRROR}/app/latest.json (${manifest.version})`)
}

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const eq = arg.indexOf('=')
    if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1)
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) out[arg.slice(2)] = true
    else out[arg.slice(2)] = argv[++i]
  }
  return out
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const [command, ...rest] = process.argv.slice(2)
  const options = args(rest)
  options.backend ??= process.env.R2_ACCESS_KEY_ID ? 's3' : 'dry-run'
  const commands = {
    inventory: async () => {
      const entries = await inventory({ releasesMonths: Number(options['releases-months'] ?? KEEP_MONTHS) })
      for (const e of entries) console.log(`${e.path}\t${e.artifact}\t${e.version}\t${e.from}`)
      console.log(`${entries.length} files`)
    },
    sync: () => sync(options),
    release: () => release(options)
  }
  if (!commands[command]) {
    console.error('Usage: node scripts/download-mirror.mjs <inventory|sync|release> [--option value ...]')
    process.exit(2)
  }
  commands[command]().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
