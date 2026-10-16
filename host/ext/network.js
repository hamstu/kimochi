/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Remote requests from extension frames (DICTIONARY_ENGINES.md §5.4).
 *
 * In Chrome an extension with host permissions fetches any origin without CORS; from
 * `hachidori://localhost` or `tenten://localhost` the WebView applies CORS, and GitHub's release
 * downloads, AnkiConnect and most audio hosts would fail. The Yomitan host routes such requests
 * through Rust's plugin-http (host/network-entry.js), but that adapter cannot serve these frames:
 * it reaches into each frame's `window` (cross-origin here), it needs Tauri IPC (extension frames
 * have no `__TAURI__`), and it only installs onto `window.__extensionHost`, which is the Yomitan
 * shim's global and absent whenever this host is the one running.
 *
 * So the request crosses to the frame's parent, the first app document above it, over the
 * frame's private MessagePort, and the parent performs it with the same plugin-http `fetch`
 * (bundled into this host; it talks to `__TAURI_INTERNALS__`), or with the page's own `fetch` where
 * there is no Tauri (the browser harness, where CORS then still applies). The response streams
 * back as transferred ArrayBuffer chunks, never JSON-encoded bytes, and is rebuilt in the frame as
 * a real `Response` whose `url` is the final URL after redirects (Hachidori checks it on GitHub
 * downloads, background-updates.js `recommendedIndexUrlMatches`).
 *
 * The top document of an engine's extension window (`ext-<id>`, §5.4) is the exception: it has
 * Tauri IPC and its own plugin-http grant (capabilities/extension-windows.json), so it fetches
 * directly (`installDirectNetwork`), and serves its offscreen iframe's requests the same way.
 *
 * Web Workers: a request made inside a worker never sees this frame's `fetch`. Hachidori downloads
 * dictionary archives from its engine and import workers (engine-service.js `fetchImportArchive`),
 * so module workers created by an extension frame are started through the worker shim
 * (worker-network.js), which hands their remote requests to the frame and on through this path.
 * 10ten's database worker (`10ten-ja-jpdict.js`, a classic worker) is left alone: data.10ten.life
 * answers with `Access-Control-Allow-Origin: *`.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { describe } from './util.js'

export { deniedHost, installFrameNetwork } from './frame-network.js'
import { deniedHost, isNativeRequest } from './frame-network.js'

/**
 * The parent side: perform one request for a child frame and stream it back over its port.
 * plugin-http where Tauri is there, the page's own `fetch` otherwise.
 */
export function createNetworkServer(win, { denied, report, fetch = null }) {
  // `fetch` is given where the server stands in for a document that is itself relayed (the worker
  // shim, worker-network.js): its requests then take that document's own route to the network.
  const doFetch = fetch ?? ((url, init) => (win.__TAURI_INTERNALS__ ? tauriFetch(url, init) : win.fetch(url, { ...init, credentials: 'omit' })))
  return {
    async serve(request, port, signal, frame) {
      const { id, url, method, headers, body } = request
      try {
        const host = new URL(url).hostname
        if (deniedHost(host, denied)) {
          report({ check: 'ext-host-host-refused', host, frame })
          throw Error(`${host} is refused by Kimochi`)
        }
        const response = await doFetch(url, { method, headers, body: body ?? undefined, signal })
        port.postMessage({
          t: 'fetch-head',
          id,
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
          url: response.url || url,
          redirected: Boolean(response.redirected || (response.url && response.url !== url))
        })
        const reader = response.body?.getReader()
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            // A chunk may be a view on a larger buffer; transfer exactly its bytes.
            const chunk = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value.buffer : value.slice().buffer
            port.postMessage({ t: 'fetch-chunk', id, chunk }, [chunk])
          }
        }
        port.postMessage({ t: 'fetch-end', id })
      } catch (error) {
        port.postMessage({ t: 'fetch-error', id, error: describe(error) })
        if (!signal.aborted) report({ check: 'ext-host-fetch-failed', url: String(url).slice(0, 300), error: describe(error), frame })
      }
    }
  }
}

/**
 * The top document of an extension window: remote `fetch` goes straight to plugin-http (or, with
 * no Tauri, the browser harness, to the page's own `fetch` without credentials), with
 * `deniedHosts` refused and reported. Same-origin and non-http(s) requests are left alone. The
 * Response keeps the final URL after redirects, which plugin-http sets.
 */
export function installDirectNetwork(win, { denied, report }) {
  const nativeFetch = win.fetch.bind(win)
  const remote = (url, init) => (win.__TAURI_INTERNALS__ ? tauriFetch(url, init) : nativeFetch(url, { ...init, credentials: 'omit' }))
  win.fetch = function fetch(input, init) {
    let url
    try {
      const raw = typeof input === 'string' || input instanceof win.URL ? String(input) : input?.url
      url = new win.URL(raw, win.document?.baseURI ?? win.location.href)
    } catch {
      return nativeFetch(input, init)
    }
    if (isNativeRequest(win, url) || !/^https?:$/.test(url.protocol) || url.origin === win.location.origin) return nativeFetch(input, init)
    if (deniedHost(url.hostname, denied)) {
      report({ check: 'ext-host-host-refused', host: url.hostname })
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    if (typeof input === 'string' || input instanceof win.URL) return remote(url.href, init)
    // A Request carries its own method, headers and body, which plugin-http reads from it; its
    // signal plugin-http only takes from `init`.
    return remote(input, input?.signal && !init?.signal ? { ...init, signal: input.signal } : init)
  }
}

/**
 * App documents run the content scripts in the page itself, so the page's `fetch` is theirs too.
 * Only the refused hosts are stopped there; everything else is Kimochi's own traffic.
 */
export function guardPageFetch(win, { denied, report }) {
  if (denied.length === 0) return
  const original = win.fetch.bind(win)
  win.fetch = function fetch(input, init) {
    try {
      const raw = typeof input === 'string' || input instanceof win.URL ? String(input) : input?.url
      const url = new win.URL(raw, win.location.href)
      if (deniedHost(url.hostname, denied)) {
        report({ check: 'ext-host-host-refused', host: url.hostname })
        return Promise.reject(new TypeError('Failed to fetch'))
      }
    } catch {
      // Not a URL we can judge; let the platform decide.
    }
    return original(input, init)
  }
}
