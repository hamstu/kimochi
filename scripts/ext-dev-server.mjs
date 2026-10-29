/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain Node module, no TypeScript build. */
// The dev-only HTTP origins for the vendored extensions (DICTIONARY_ENGINES.md §4 and §9), used by
// `vite.dev.config.ts`. In Tauri each extension has its own custom scheme (`hachidori://localhost/`);
// a plain browser cannot load those, so for browser testing each extension gets its own port
// instead, which is just as much its own origin:
//
//   http://127.0.0.1:<port>/<path>             → the engine's tree (`engineTree`)
//   http://127.0.0.1:<port>/__kimochi/<path>   → dist/spike/<path> (the host scripts and pages)
//
// Every response carries the headers the custom schemes send. Extension HTML pages get the
// generic host injected as their first script, standing in for native's document-start injection.
// Kept out of `vite.dev.config.ts` so the path and injection rules are unit-testable.
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { applyPatches, patchesFile } from './extension-patches.mjs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))

/**
 * The app's local data directory for `identifier`, as Tauri's `app_local_data_dir()` names it:
 * where the app keeps its engine downloads (`<dir>/extensions/<id>/<version>/`). `npm run dev`
 * and the bundles share `dev.kimochi.app`, so the dev server sees what the app downloaded.
 */
export function appLocalDataDir(identifier = 'dev.kimochi.app', { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', identifier)
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), identifier)
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), identifier)
}

/**
 * The release the dev server serves an engine from, in the app's own order (extension_store.rs
 * `serving_files`): the app's download of the pinned version when its tree is there; else the
 * newest earlier release (`extensions/<id>.previous.json`) whose tree is there, which is what an
 * app update leaves in use while the new pin downloads in the background (`installed_previous`);
 * else the developer cache that `scripts/sync-extension.mjs` fills (`extensions/<id>/`), unless
 * `KIMOCHI_EXTENSIONS_NO_DEV_TREE` is set, which is how the real download is tested in
 * `npm run dev`. Null when none is there.
 *
 * `{ dir, version, files, source }`: `files` is that release's own file map, so the paths the app
 * origin answers are the served release's (an earlier Yomitan can have files the pin has not), and
 * `version` is the one Settings → Dictionary names (`serving_previous`): the two cannot disagree.
 * Rust's session stickiness (the windows keep their release until a switch reloads them) only
 * differs from this for the moment between an update's install and its switch.
 */
export async function engineServing(id, { env = process.env, store = path.join(appLocalDataDir(), 'extensions'), extensions = path.join(repo, 'extensions') } = {}) {
  const json = async (name) => JSON.parse(await readFile(path.join(extensions, `${id}.${name}.json`), 'utf8'))
  const isDir = async (dir) => (await stat(dir).catch(() => null))?.isDirectory() ?? false
  const source = await json('source')
  const pinned = path.join(store, id, source.version)
  if (await isDir(pinned)) return { dir: pinned, version: source.version, files: await json('sha256'), source: 'downloaded' }
  const previous = await json('previous').catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const release of previous) {
    const dir = path.join(store, id, release.version)
    if (await isDir(dir)) return { dir, version: release.version, files: release.files, source: 'downloaded' }
  }
  if (env.KIMOCHI_EXTENSIONS_NO_DEV_TREE) return null
  const cache = path.join(extensions, id)
  if (!(await stat(path.join(cache, 'manifest.json')).catch(() => null))?.isFile()) return null
  return { dir: cache, version: source.version, files: await json('sha256'), source: 'development' }
}

/** The directory `engineServing` serves an engine from, or null. */
export async function engineTree(id, options) {
  return (await engineServing(id, options))?.dir ?? null
}

export const HOST_SCRIPT_TAG = '<script src="/__kimochi/ext-host.js"></script>'

/**
 * The browser harness's stand-in for native's all-frames injection of the Yomitan shim, on the app
 * origin (DICTIONARY_ENGINES.md §11.5). `ui/dictionary-harness.html?engine=yomitan` sets this cookie
 * on its own origin; while it is present, `vite.dev.config.ts` serves the app origin's HTML (the
 * backend page `/spike/background.html`, Yomitan's `/popup.html`, `/settings.html`, …) with
 * `YOMITAN_SHIM_TAG` as the first child of `<head>`, so the shim runs before the page's own
 * scripts as it does in the overlay. A Tauri webview never carries the cookie (its own cookie jar),
 * and native's copy installs first anyway (`__yomitanShim`).
 */
export const YOMITAN_SHIM_TAG = '<script src="/spike/shim.js"></script>'
const HARNESS_SHIM_COOKIE = /(?:^|;\s*)kimochi-harness-shim=yomitan(?:;|$)/
export function harnessInjectsYomitanShim(cookie) {
  return typeof cookie === 'string' && HARNESS_SHIM_COOKIE.test(cookie)
}

/** The file under `base` for a URL path, or null (never a directory, never outside `base`). */
export async function fileUnder(base, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const file = path.join(base, path.normalize(decoded))
  if (file !== base && !file.startsWith(base + path.sep)) return null
  const info = await stat(file).catch(() => null)
  return info?.isFile() ? file : null
}

/** The first match of `tag` (a regex source) outside HTML comments, or null. */
function firstTag(html, tag) {
  const pattern = new RegExp(`<!--[\\s\\S]*?-->|${tag}`, 'gi')
  for (const match of html.matchAll(pattern)) if (!match[0].startsWith('<!--')) return match
  return null
}

/**
 * `html` with the host script as the first child of `<head>`: right after the `<head>` tag, else
 * right after `<html …>` (the parser then opens an implied head around it), else right after the
 * doctype, else at the very start. Never before the doctype, which would mean quirks mode.
 */
export function injectHostScript(html, tag = HOST_SCRIPT_TAG) {
  const at = firstTag(html, '<head(?=[\\s>/])[^>]*>') ?? firstTag(html, '<html(?=[\\s>/])[^>]*>') ?? firstTag(html, '<!doctype[^>]*>')
  if (!at) return tag + html
  const end = at.index + at[0].length
  return html.slice(0, end) + tag + html.slice(end)
}

/** Resolves a request path to `{file, inject}` for an extension origin, or null for a 404. */
export async function resolveExtensionPath({ extRoot, spikeRoot }, urlPath) {
  if (urlPath === '/__kimochi' || urlPath.startsWith('/__kimochi/')) {
    const file = await fileUnder(spikeRoot, urlPath.slice('/__kimochi'.length) || '/')
    return file ? { file, inject: false } : null
  }
  const file = await fileUnder(extRoot, urlPath)
  return file ? { file, inject: file.toLowerCase().endsWith('.html') } : null
}

// ---------------------------------------------------------------- plugin-http stand-in

export const PROXY_PATH = '/__kimochi/proxy'

/** A Tauri scope URL glob (`https://*.githubusercontent.com/**`) as a RegExp. */
export function scopeGlob(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      source += '.*'
      i += 1
    } else if (c === '*') source += '[^/]*'
    else source += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** The `http:default` allow-list of a capability file (src-tauri/capabilities/network.json). */
export function scopeFromCapability(capability) {
  const globs = []
  for (const permission of capability.permissions ?? []) {
    if (typeof permission === 'object' && permission.identifier === 'http:default') {
      for (const entry of permission.allow ?? []) if (entry?.url) globs.push(entry.url)
    }
  }
  return globs.map(scopeGlob)
}

/** Like plugin-http's scope check: only the URL asked for is judged; redirects are followed freely. */
export function scopeAllows(scope, url) {
  return scope.some((pattern) => pattern.test(url))
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** Request headers plugin-http drops (its `is_unsafe_header`) or that make no sense to forward. */
const UNSAFE_REQUEST = /^(accept-charset|accept-encoding|access-control-request-.*|connection|content-length|cookie|date|dnt|expect|host|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*|keep-alive)$/i

/**
 * Connect middleware for `GET|HEAD|POST /__kimochi/proxy?url=<remote>` on the dev server: the
 * browser harness's stand-in for Rust's plugin-http (ui/dictionary-harness.js `?fetch=proxy`), so
 * Hachidori's real recommended downloads (GitHub release redirects, api.jiten.moe) run in Chrome
 * without CORS, with plugin-http's semantics: the scope is checked on the requested URL only,
 * redirects are followed, no `Accept-Encoding` is sent (reqwest is built without gzip there, so
 * bodies arrive as stored), and the final URL comes back (as `X-Kimochi-Final-Url`). Upstream
 * status and headers come back as `X-Kimochi-Status` / `X-Kimochi-Headers` (JSON pairs) so
 * nothing about them is lost to the browser's own header rules. Loopback clients only, and only
 * URLs the capability allows; never part of a build.
 *
 * Forwarded request headers travel as JSON pairs in `X-Kimochi-Forward-Headers`.
 *
 * @param {{scope: RegExp[], fetchImpl?: typeof fetch, log?: (message: string) => void}} options
 * @returns {(req: any, res: any, next?: () => void) => Promise<void>}
 */
export function createProxyMiddleware({ scope, fetchImpl = globalThis.fetch, log = () => {} }) {
  return async (req, res, next) => {
    const [pathname, query = ''] = (req.url ?? '').split('?')
    if (pathname !== PROXY_PATH) return next?.()
    const send = (status, message) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(message)
    }
    if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) return send(403, 'The proxy answers loopback clients only')
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return send(405, 'GET, HEAD or POST')
    const target = new URLSearchParams(query).get('url') ?? ''
    let url
    try {
      url = new URL(target)
    } catch {
      return send(400, 'url= is not a URL')
    }
    if (!/^https?:$/.test(url.protocol) || !scopeAllows(scope, url.href)) {
      // plugin-http's own wording (Error::UrlNotAllowed), so a refusal reads the same as in the app.
      return send(403, `url not allowed on the configured scope: ${url.href}`)
    }
    const headers = { 'accept-encoding': 'identity', 'user-agent': 'tauri-plugin-http/2.6.0' }
    try {
      for (const [name, value] of JSON.parse(req.headers['x-kimochi-forward-headers'] ?? '[]')) {
        if (!UNSAFE_REQUEST.test(name)) headers[name.toLowerCase()] = String(value)
      }
    } catch {
      return send(400, 'X-Kimochi-Forward-Headers is not JSON')
    }
    let body
    if (req.method === 'POST') {
      const parts = []
      for await (const part of req) parts.push(part)
      body = Buffer.concat(parts)
    }
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    let upstream
    try {
      upstream = await fetchImpl(url.href, { method: req.method, headers, body, redirect: 'follow', signal: controller.signal })
    } catch (error) {
      log(`proxy ${url.href}: ${error.message}`)
      return send(502, `error sending request for url (${url.href}): ${error.cause?.message ?? error.message}`)
    }
    res.statusCode = 200
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Kimochi-Status', String(upstream.status))
    res.setHeader('X-Kimochi-Status-Text', encodeURIComponent(upstream.statusText ?? ''))
    res.setHeader('X-Kimochi-Final-Url', upstream.url || url.href)
    res.setHeader('X-Kimochi-Headers', encodeURIComponent(JSON.stringify([...upstream.headers])))
    res.setHeader('Content-Type', 'application/octet-stream')
    if (req.method === 'HEAD' || !upstream.body) {
      res.end()
      return
    }
    try {
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve))
      }
      res.end()
    } catch (error) {
      log(`proxy ${url.href}: body: ${error.message}`)
      res.destroy(error)
    }
  }
}

// ---------------------------------------------------------------- ext_relay stand-in

export const RELAY_PATH = '/__kimochi/relay'

/**
 * The browser harness's stand-in for native `ext_relay` (main.rs), shared by every origin the dev
 * server answers on: the harness pages on the app origin and the extension window's page on an
 * extension origin are different origins, so no in-browser channel (BroadcastChannel, storage)
 * reaches across. One bus per dev server process; each origin mounts the same middleware, so each
 * page talks to its own origin and nothing needs CORS.
 *
 *   GET  /__kimochi/relay?channel=<engine>   Server-Sent Events: one `data:` line per message
 *   POST /__kimochi/relay?channel=<engine>   body `{from, to, payload}`; answered 204
 *
 * Like native, the bus stamps `{from, to, seq}` with one counter per sender label (per channel),
 * which survives a page reload, and delivers every message to every listener; receivers filter
 * on `to` and drop their own (host/ext/primitives.js `listenRelay`). Loopback clients only.
 */
export function createRelayBus() {
  /** channel → {clients: Set<res>, seq: Map<from, number>} */
  const channels = new Map()
  const channelOf = (name) => {
    let channel = channels.get(name)
    if (!channel) {
      channel = { clients: new Set(), seq: new Map() }
      channels.set(name, channel)
    }
    return channel
  }
  const publish = (name, { from, to = null, payload }) => {
    const channel = channelOf(name)
    const seq = (channel.seq.get(from) ?? 0) + 1
    channel.seq.set(from, seq)
    const message = { from, to, seq, payload }
    const line = `data: ${JSON.stringify(message)}\n\n`
    for (const client of channel.clients) client.write(line)
    return message
  }
  const middleware = async (req, res, next) => {
    const [pathname, query = ''] = (req.url ?? '').split('?')
    if (pathname !== RELAY_PATH) return next?.()
    res.setHeader('Cache-Control', 'no-store')
    if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) {
      res.statusCode = 403
      return res.end('The relay answers loopback clients only')
    }
    const name = new URLSearchParams(query).get('channel') || 'default'
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
      res.write(': kimochi relay\n\n')
      const channel = channelOf(name)
      channel.clients.add(res)
      req.on('close', () => channel.clients.delete(res))
      return undefined
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      return res.end('GET or POST')
    }
    const parts = []
    for await (const part of req) parts.push(part)
    let body
    try {
      body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    } catch {
      res.statusCode = 400
      return res.end('not JSON')
    }
    if (typeof body?.from !== 'string' || !body.from) {
      res.statusCode = 400
      return res.end('from is required')
    }
    publish(name, body)
    res.statusCode = 204
    return res.end()
  }
  return { middleware, publish, channels }
}

/**
 * The harness's stand-in for native's prelude and IPC in the extension window's page
 * (`/__kimochi/ext-background.html?engine=<id>&window=ext-<id>` on an extension port): its own
 * `<script>` as the first child of `<head>`, before the host. Only for that page and only with
 * `window=ext-<id>` in the query, so nothing else on the extension origin changes.
 */
export function harnessTagFor(urlPath, query, scriptUrl) {
  if (!scriptUrl || urlPath !== '/__kimochi/ext-background.html') return null
  const label = new URLSearchParams(query).get('window') ?? ''
  if (!/^ext-[a-z0-9-]{1,32}$/.test(label)) return null
  return `<script src="${scriptUrl.replace(/"/g, '&quot;')}"></script>`
}

/**
 * An HTTP server for one extension origin. `mime` maps a lowercase extension (`.js`) to a
 * Content-Type. Not listening yet: the caller calls `listen`. `middleware` (connect-style, tried
 * in order before the files) adds the dev proxy and the relay bus; `harnessScript` is the URL of
 * the harness's native stand-in for the extension window's page (see `harnessTagFor`). `engine`
 * names the extension, so its files are served with Kimochi's patches (host/ext/patches.json).
 *
 * @param {{engine?: string | null, extRoot: string, spikeRoot: string, mime: Record<string, string>, log?: (message: string) => void, middleware?: Array<(req: any, res: any, next: () => void) => unknown>, harnessScript?: string | null}} options
 */
export function createExtensionServer({ engine = null, extRoot, spikeRoot, mime, log = () => {}, middleware = [], harnessScript = null }) {
  const files = createExtensionFiles({ engine, extRoot, spikeRoot, mime, log, harnessScript })
  return http.createServer((req, res) => {
    let index = 0
    const next = () => {
      const handler = middleware[index++]
      if (!handler) return void files(req, res)
      void Promise.resolve(handler(req, res, next)).catch((error) => {
        log(`${req.url}: ${error.message}`)
        if (!res.headersSent) res.writeHead(500).end()
      })
    }
    next()
  })
}

function createExtensionFiles({ engine, extRoot, spikeRoot, mime, log, harnessScript }) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', '*')
      res.writeHead(204).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end()
      return
    }
    const urlPath = (req.url ?? '/').split(/[?#]/)[0]
    const query = (req.url ?? '').split('#')[0].split('?')[1] ?? ''
    try {
      const found = await resolveExtensionPath({ extRoot, spikeRoot }, urlPath)
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Not found: ${urlPath}`)
        return
      }
      res.setHeader('Content-Type', mime[path.extname(found.file).toLowerCase()] ?? 'application/octet-stream')
      const harnessTag = harnessTagFor(urlPath, query, harnessScript)
      if (harnessTag) {
        const body = Buffer.from(injectHostScript(await readFile(found.file, 'utf8'), harnessTag))
        res.setHeader('Content-Length', body.length)
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      // Kimochi's edits to the engine's own files, as the app serves them (host/ext/patches.json).
      const rel = path.relative(extRoot, found.file).split(path.sep).join('/')
      if (engine && !found.inject && patchesFile(engine, rel)) {
        const { text, skipped } = applyPatches(engine, rel, await readFile(found.file, 'utf8'))
        for (const id of skipped) log(`patch ${id} does not apply to ${rel}; served unpatched`)
        const body = Buffer.from(text)
        res.setHeader('Content-Length', body.length)
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      if (found.inject) {
        const body = Buffer.from(injectHostScript(await readFile(found.file, 'utf8')))
        res.setHeader('Content-Length', body.length)
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      res.setHeader('Content-Length', (await stat(found.file)).size)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(found.file)
        .on('error', (error) => {
          log(`${urlPath}: ${error.message}`)
          res.destroy(error)
        })
        .pipe(res)
    } catch (error) {
      log(`${urlPath}: ${error.message}`)
      if (!res.headersSent) res.writeHead(500).end()
      else res.destroy()
    }
  }
}
