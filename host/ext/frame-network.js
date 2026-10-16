/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * The requesting side of the remote-fetch relay (network.js): `fetch` for remote URLs goes up a
 * private port to whoever can reach the network. Kept apart from network.js so the worker shim
 * (worker-network.js) can bundle it without plugin-http.
 */
// Not util.js `randomId`: util.js imports the engine descriptors (both manifests), which the
// worker shim's bundle has no use for.
let nextRequest = 0
const requestId = () => `F${Date.now().toString(36)}-${(nextRequest++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const NULL_BODY = new Set([101, 103, 204, 205, 304])

export function deniedHost(hostname, denied) {
  return denied.some((host) => hostname === host || hostname.endsWith(`.${host}`))
}

/**
 * Install the requesting side: `fetch` for remote URLs goes up `upstream`. `base` resolves relative URLs: a frame's own location, or for a shimmed worker the URL of the
 * script it really runs (its `location` is the shim's).
 */
export function installFrameNetwork(win, { upstream, denied, report, base = null }) {
  const nativeFetch = win.fetch.bind(win)
  const baseHref = () => base ?? win.location.href
  const streams = new Map()

  const onFrame = (frame) => {
    const entry = streams.get(frame.id)
    if (!entry) return
    if (frame.t === 'fetch-head') entry.head(frame)
    else if (frame.t === 'fetch-chunk') entry.chunk(new Uint8Array(frame.chunk))
    else if (frame.t === 'fetch-end') entry.end()
    else if (frame.t === 'fetch-error') entry.fail(frame.error)
  }

  async function remoteFetch(input, init, href) {
    const request = new win.Request(input, init)
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer()
    const id = requestId()
    const signal = request.signal
    if (signal?.aborted) throw new win.DOMException('The operation was aborted.', 'AbortError')
    return new Promise((resolve, reject) => {
      let controller
      let settledHead = false
      const stream = new win.ReadableStream({
        start: (c) => {
          controller = c
        },
        cancel: () => upstream.post({ t: 'fetch-abort', id })
      })
      const abort = () => {
        upstream.post({ t: 'fetch-abort', id })
        const error = new win.DOMException('The operation was aborted.', 'AbortError')
        if (!settledHead) reject(error)
        else controller.error(error)
        streams.delete(id)
      }
      signal?.addEventListener('abort', abort, { once: true })
      streams.set(id, {
        head: ({ status, statusText, headers, url, redirected }) => {
          settledHead = true
          const response = new win.Response(NULL_BODY.has(status) ? null : stream, {
            status: status >= 200 && status <= 599 ? status : 502,
            statusText: statusText ?? '',
            headers
          })
          Object.defineProperty(response, 'url', { value: url || href })
          Object.defineProperty(response, 'redirected', { value: Boolean(redirected) })
          resolve(response)
        },
        chunk: (bytes) => controller.enqueue(bytes),
        end: () => {
          streams.delete(id)
          signal?.removeEventListener('abort', abort)
          try {
            controller.close()
          } catch {
            // Null-body response: the stream was never handed out.
          }
        },
        fail: (message) => {
          streams.delete(id)
          signal?.removeEventListener('abort', abort)
          // Once, however many relay hops it crossed (a worker's request crosses two).
          const error = new TypeError(/^Failed to fetch\b/.test(message) ? message : `Failed to fetch: ${message}`)
          if (!settledHead) reject(error)
          else controller.error(error)
        }
      })
      upstream.post(
        { t: 'fetch', id, url: href, method: request.method, headers: [...request.headers], body },
        body ? [body] : []
      )
    })
  }

  win.fetch = function fetch(input, init) {
    let href
    try {
      const raw = typeof input === 'string' || input instanceof win.URL ? String(input) : input?.url
      href = new win.URL(raw, baseHref()).href
    } catch {
      return nativeFetch(input, init)
    }
    const url = new win.URL(href)
    // A relative string is handed on resolved, so a worker shim's own location never leaks in.
    const local = typeof input === 'string' || input instanceof win.URL ? href : input
    if (isNativeRequest(win, url) || !/^https?:$/.test(url.protocol) || url.origin === win.location.origin) return nativeFetch(local, init)
    if (deniedHost(url.hostname, denied)) {
      report({ check: 'ext-host-host-refused', host: url.hostname })
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    return remoteFetch(local, init, href)
  }
  return { onFrame }
}

/** Windows maps native protocols to HTTP. IPC must never invoke plugin-http through itself. */
export function isNativeRequest(win, url) {
  return win.__KIMOCHI_PLATFORM__?.os === 'windows' && url.protocol === 'http:' &&
    ['ipc.localhost', 'capture.localhost'].includes(url.hostname)
}

