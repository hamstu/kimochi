/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Remote requests from Web Workers (DICTIONARY_ENGINES.md §5.4).
 *
 * A worker has its own `fetch`, which the frame's adapter (network.js) never sees, so in Chrome it
 * meets the extension origin's CORS and in Tauri it bypasses plugin-http. Hachidori downloads every
 * recommended dictionary from inside its workers: offscreen.js `startWorkerEngine` starts
 * `engine-worker-*.js` as a module worker, engine-worker-runtime.js `importInIsolatedWorker`
 * starts `import-worker.js` from that worker, and both run engine-service.js
 * `fetchImportArchive` → `fetch(request.archiveUrl)` on GitHub release URLs, whose redirects carry
 * no `Access-Control-Allow-Origin`. Without this the setup page reports "reading the archive
 * failed. Failed to fetch" for all five recommended dictionaries.
 *
 * So an extension frame's same-origin *module* workers are started through the shim
 * `<origin>/__kimochi/ext-worker.js?src=<script>` (worker-entry.js): it installs a relaying
 * `fetch` (frame-network.js, the same client the frame uses), then imports the real script. The
 * frame hands the shim a private MessagePort as the worker's very first message; the shim takes
 * that message (stopImmediatePropagation), and holds every other message until the real script has
 * been evaluated and registered its listeners, then re-dispatches them in order. On the frame's
 * side the port is served like a child frame's (network.js `createNetworkServer`), with the
 * frame's own relayed `fetch`, so the request goes to the app document and, in Tauri, plugin-http.
 * The response streams back and keeps its final URL (engine-service.js
 * `remoteArchiveFinalUrlMatches` checks it against the recommended source).
 *
 * Not shimmed: classic workers (10ten's `10ten-ja-jpdict.js`; data.10ten.life allows any
 * origin), `blob:`/`data:` workers (zip.js codec workers, which never fetch), and cross-origin
 * scripts. A nested worker started from a shimmed worker is shimmed too: its port is handed up to
 * the frame (`adopt`) and served there like the first.
 *
 * What the shim changes for the real script: `self.location` is the shim's URL. Relative `fetch`
 * and `new Worker` URLs are resolved against the real script instead; Hachidori and the hoshidicts
 * Emscripten build locate everything through `import.meta.url`, which is untouched.
 */
import { installFrameNetwork } from './frame-network.js'

/** The key of the first message a shimmed worker receives. */
export const WORKER_TAG = '__kimochiWorkerNetwork'
export const WORKER_SHIM_PATH = '/__kimochi/ext-worker.js'

/**
 * `scheme://host` of a URL. Not `URL.origin`: for a non-special scheme such as
 * `hachidori://localhost` that is the opaque "null" (util.js `originOf`, not imported here so the
 * worker bundle stays free of the engine descriptors).
 */
const originOf = (url) => (url.host ? `${url.protocol}//${url.host}` : url.origin)

/** The shim URL for `href`, or null when the worker should start as it is. */
export function shimFor(href, options, { origin }) {
  if (options?.type !== 'module') return null
  let url
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (originOf(url) !== origin || url.pathname.startsWith('/__kimochi/')) return null
  return `${origin}${WORKER_SHIM_PATH}?src=${encodeURIComponent(url.href)}`
}

/**
 * Replace `scope.Worker` so qualifying workers start through the shim. `connect(worker, port)`
 * wires the new worker's private port; `base()` resolves relative script URLs.
 */
export function wrapWorkerConstructor(scope, { origin, base, connect }) {
  const NativeWorker = scope.Worker
  if (typeof NativeWorker !== 'function' || NativeWorker.__kimochiShimmed) return
  function Worker(url, options) {
    if (!new.target) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator.")
    let href
    try {
      href = new URL(String(url), base()).href
    } catch {
      return new NativeWorker(url, options)
    }
    const shim = shimFor(href, options, { origin })
    if (!shim) return new NativeWorker(url, options)
    const worker = new NativeWorker(shim, options)
    const channel = new scope.MessageChannel()
    connect(worker, channel.port1)
    worker.postMessage({ [WORKER_TAG]: true }, [channel.port2])
    return worker
  }
  Worker.prototype = NativeWorker.prototype
  Worker.__kimochiShimmed = true
  try {
    scope.Worker = Worker
  } catch {
    Object.defineProperty(scope, 'Worker', { value: Worker, configurable: true, writable: true })
  }
}

/**
 * The frame side: every shimmed worker's port (and the ports of the workers it starts) is served
 * by `server` (a network.js `createNetworkServer` over the frame's own `fetch`).
 */
export function installWorkerNetwork(win, { origin, server, report }) {
  const serve = (port) => {
    const fetches = new Map()
    port.onmessage = (event) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.t === 'fetch') {
        const controller = new AbortController()
        fetches.set(data.id, controller)
        void server.serve(data, port, controller.signal, 'worker').finally(() => fetches.delete(data.id))
      } else if (data.t === 'fetch-abort') {
        fetches.get(data.id)?.abort()
      } else if (data.t === 'adopt' && event.ports?.[0]) {
        serve(event.ports[0])
      } else if (data.t === 'log' && data.value) {
        report(data.value)
      }
    }
    port.start?.()
  }
  wrapWorkerConstructor(win, {
    origin,
    base: () => win.document?.baseURI ?? win.location.href,
    connect: (worker, port) => serve(port)
  })
}

/**
 * WebKit: keep IndexedDB records of freshly written files as bytes, never as Blobs.
 *
 * Hachidori's engine worker (engine-service.js `storeLargeIdbfsFilesAsBlobs`, the single-thread
 * IDBFS engine Kimochi runs) stores every file of 1 MiB or more as `new Blob([bytes])` in IDBFS's
 * IndexedDB, then, once the sync has finished, swaps each MEMFS file for the Blob read back from
 * IndexedDB (`adoptPersistedBlobs`) and serves the engine's reads and `mmap`s from it with
 * `FileReaderSync`. That is a Chromium optimisation. In WebKit (WKWebView, Safari, WebKitGTK) a
 * Blob that a worker reads back from IndexedDB in a fresh data store is unusable: every `slice`
 * of it has size 0 and `FileReaderSync.readAsArrayBuffer` throws `NotFoundError` ("The object can
 * not be found here."). Each import's commit then fails as "importing the dictionary failed. The
 * object can not be found here.", which is what Kimochi's first-run setup showed for most of the
 * five recommended dictionaries until they were retried (reproduced in a bare WKWebView:
 * evidence/dictionary-engines/hachidori-install-*.json).
 *
 * So in WebKit the shim lets the worker build those Blobs as before but puts the bytes they were
 * made from into IndexedDB instead: a record whose `contents` is a Uint8Array is exactly what
 * IDBFS writes for small files and what earlier Hachidori versions wrote for all files, so the
 * engine keeps the file as an array (`adoptPersistedBlobs` adopts Blobs only) and restores it as
 * one on the next start. Records already stored as Blobs still load through the engine's own
 * Blob path. Only Blobs built in this worker from a single byte array are swapped; every other
 * Blob (zip.js parts, Blobs read from IndexedDB, renamed Blob-backed files) is stored as it is.
 */
export const BLOB_RECORD_MIN_BYTES = 1024 * 1024
export function isWebKit(navigator) {
  const ua = String(navigator?.userAgent ?? '')
  return /AppleWebKit\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR)\//.test(ua)
}

export function keepIdbRecordsAsBytes(scope, { minBytes = BLOB_RECORD_MIN_BYTES } = {}) {
  const NativeBlob = scope.Blob
  const store = scope.IDBObjectStore?.prototype
  if (typeof NativeBlob !== 'function' || !store || NativeBlob.__kimochiBytes) return false
  const sources = new WeakMap()
  class Blob extends NativeBlob {
    constructor(parts, options) {
      super(parts, options)
      const only = Array.isArray(parts) && parts.length === 1 ? parts[0] : null
      if (only instanceof Uint8Array && only.byteLength >= minBytes && only.byteLength === this.size) sources.set(this, only)
    }

    // Blobs made anywhere else (IndexedDB, `slice`, `Response.blob`) are still Blobs.
    static [Symbol.hasInstance](value) {
      return value instanceof NativeBlob
    }
  }
  Blob.__kimochiBytes = true
  const swap = (value) => {
    const contents = value && typeof value === 'object' ? value.contents : undefined
    const bytes = contents ? sources.get(contents) : undefined
    return bytes ? { ...value, contents: bytes } : value
  }
  for (const method of ['put', 'add']) {
    const original = store[method]
    if (typeof original !== 'function') continue
    store[method] = function (value, ...rest) {
      return original.call(this, swap(value), ...rest)
    }
  }
  try {
    scope.Blob = Blob
  } catch {
    Object.defineProperty(scope, 'Blob', { value: Blob, configurable: true, writable: true })
  }
  return true
}

/**
 * The worker side, run by the shim before the real script. Returns once the script named by
 * `?src=` has been imported (or has failed, which is rethrown as the worker's uncaught error).
 * `load` is the module loader (a test seam; the shim itself uses dynamic `import()`); `webkit`
 * overrides the user-agent test that decides whether `keepIdbRecordsAsBytes` applies.
 */
export function runWorkerShim(scope, { load = (src) => import(/* @vite-ignore */ src), webkit = null } = {}) {
  const src = new URL(scope.location.href).searchParams.get('src')
  if (!src) return Promise.resolve()
  const origin = originOf(new URL(src))

  let port = null
  const outbox = []
  const send = (message, transfer = []) => {
    if (port) port.postMessage(message, transfer)
    else outbox.push([message, transfer])
  }
  const report = (value) => send({ t: 'log', value: { window: 'worker', script: src, ...value } })
  const network = installFrameNetwork(scope, { upstream: { post: send }, denied: [], report, base: src })
  if (webkit ?? isWebKit(scope.navigator)) keepIdbRecordsAsBytes(scope)

  const held = []
  const hold = (event) => {
    event.stopImmediatePropagation()
    if (!port && event.data && typeof event.data === 'object' && event.data[WORKER_TAG] === true && event.ports?.[0]) {
      port = event.ports[0]
      port.onmessage = (frame) => network.onFrame(frame.data)
      port.start?.()
      for (const [message, transfer] of outbox.splice(0)) port.postMessage(message, transfer)
      return
    }
    held.push(event)
  }
  scope.addEventListener('message', hold)

  // Workers this worker starts: their port goes up to the frame, which serves it.
  wrapWorkerConstructor(scope, {
    origin,
    base: () => src,
    connect: (worker, nested) => send({ t: 'adopt' }, [nested])
  })

  const release = () => {
    scope.removeEventListener('message', hold)
    for (const event of held.splice(0)) {
      scope.dispatchEvent(new scope.MessageEvent('message', { data: event.data, ports: [...(event.ports ?? [])] }))
    }
  }
  return Promise.resolve().then(() => load(src)).then(release, (error) => {
    release()
    report({ check: 'ext-host-worker-failed', error: String(error?.message ?? error) })
    // As an uncaught error, so the creator's `worker.onerror` sees it as it would without the shim.
    setTimeout(() => {
      throw error
    }, 0)
  })
}
