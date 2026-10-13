/**
 * The browser harness's stand-in for native (DICTIONARY_ENGINES.md §9): `window.__TAURI__` with the
 * few commands the extension host calls, an `ext_relay` over the dev server's relay bus, and (with
 * `?fetch=proxy`) a plugin-http stand-in. A classic script that must run before the host, which
 * reads all of it synchronously when it installs. Does nothing inside Tauri.
 *
 * Two kinds of page load it:
 *
 * - the harness pages on the app origin (ui/dictionary-harness.html): the hub (`overlay`), or with
 *   `?window=dictionary|log` that Kimochi window, a relay client of the hub;
 * - the extension window's page, `<extension origin>/__kimochi/ext-background.html?engine=<id>&
 *   window=ext-<id>` on the dev server's extension port, where the dev server puts this script
 *   first (scripts/ext-dev-server.mjs `harnessTagFor`) as native puts its preludes. The hub opens
 *   it from `extension_window_ensure`, as native creates the hidden `ext-<id>` window. Its
 *   commands are the invoke guard's (main.rs): `ext_relay` and `report` only.
 *
 * The relay: every page of one engine talks to `/__kimochi/relay?channel=<engine>` on its own
 * origin (one bus behind every origin of the dev server), which stamps `{from, to, seq}` with one
 * counter per sender label like main.rs `ext_relay`, and delivers every message to every page.
 *
 * `?fetch=proxy[&chunk=<bytes>&ipc=<ms>]`: remote requests go through the real plugin-http client
 * code bundled in ext-host.js (host/ext/network.js), whose IPC commands are answered here over the
 * dev server's proxy (scripts/ext-dev-server.mjs `createProxyMiddleware`, on this page's origin)
 * instead of Rust. That is plugin-http's wire behaviour: `fetch` → `fetch_send` (status, headers,
 * final URL after redirects) → one `fetch_read_body` round trip per body chunk (`?chunk=<bytes>`,
 * default 16 KiB; each answer ends in a 0 byte, the end is a lone 1 byte), with `?ipc=<ms>` of
 * latency per call. Without it the page's own fetch is used and GitHub's CORS stops downloads.
 *
 * `?frame=none`: the mining-screenshot frame source answers as before any scan.
 */
;(() => {
  if (window.__TAURI__ || window.__harnessNative) return
  const params = new URLSearchParams(location.search)
  const extWindow = /^ext-(hachidori|tenten)$/.exec(params.get('window') ?? '')
  const engine = extWindow ? extWindow[1] : ['tenten', 'yomitan'].includes(params.get('engine')) ? params.get('engine') : 'hachidori'
  const label = extWindow ? extWindow[0] : ['dictionary', 'log'].includes(params.get('window')) ? params.get('window') : 'overlay'
  const origins = {
    hachidori: (params.get('hachidori') ?? 'http://127.0.0.1:1440').replace(/\/+$/, ''),
    tenten: (params.get('tenten') ?? 'http://127.0.0.1:1441').replace(/\/+$/, '')
  }
  const HARNESS_FRAME = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAFElEQVR4nGM4oaFBEmIY1TAoNAAADHGdgai0BAsAAAAASUVORK5CYII='
  const storageKey = (extension) => `kimochi.harness.chrome-local-${extension ?? 'yomitan'}`
  const native = (window.__harnessNative = { engine, label, origins, extensionWindow: null, captures: [], http: null, relay: null, reports: [] })

  if (extWindow) {
    // What native's label and engine preludes publish in the `ext-<id>` window.
    window.__kimochiPanelLabel = label
    window.__kimochiExtensionOrigins = origins
    window.__kimochiDictionaryEngine = engine
  }

  // ---------------------------------------------------------------- the relay bus

  // Yomitan's harness page relays nothing; the extension engines always need the bus, since their
  // background runs in the extension window's page.
  const relayed = engine !== 'yomitan'
  const relay = relayed && typeof EventSource === 'function'
    ? { url: `/__kimochi/relay?channel=${encodeURIComponent(engine)}`, listeners: new Set(), open: null }
    : null
  if (relay) {
    native.relay = relay
    const source = new EventSource(relay.url)
    relay.open = new Promise((resolve) => source.addEventListener('open', () => resolve(), { once: true }))
    source.onmessage = ({ data }) => {
      let message
      try {
        message = JSON.parse(data)
      } catch {
        return
      }
      if (message?.payload?.kind === 'harness-report' && label === 'overlay') {
        window.dispatchEvent(new CustomEvent('kimochi-harness-remote-report', { detail: message.payload.value }))
        return
      }
      for (const listener of relay.listeners) listener({ event: 'ext-relay', payload: message })
    }
    relay.post = async (to, payload) => {
      const response = await fetch(relay.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: label, to, payload }) })
      if (!response.ok) throw Error(`relay: ${response.status} ${await response.text()}`)
    }
  }

  // ---------------------------------------------------------------- commands

  const report = ({ value } = {}) => {
    console.log('[report]', value)
    native.reports.push(value)
    // The extension window's diagnostics also show in the hub page's log.
    if (extWindow && relay) void relay.post('overlay', { kind: 'harness-report', value }).catch(() => {})
    return null
  }
  const extRelay = async (args) => {
    if (!relay) {
      console.log('[harness] ext_relay (no other windows here)', args)
      return null
    }
    await relay.post(args?.target ?? null, args?.payload)
    return null
  }

  /** main.rs `extension_window_ensure`: open (or, with `reload`, reload) the extension window's page. */
  const ensureExtensionWindow = ({ engine: wanted, reload } = {}) => {
    if (wanted !== engine) throw Error(`invalid: ${wanted} is not the active dictionary engine (${engine} is)`)
    const url = new URL(`${origins[engine]}/__kimochi/ext-background.html`)
    url.searchParams.set('engine', engine)
    url.searchParams.set('window', `ext-${engine}`)
    url.searchParams.set('hachidori', origins.hachidori)
    url.searchParams.set('tenten', origins.tenten)
    for (const key of ['fetch', 'chunk', 'ipc']) if (params.has(key)) url.searchParams.set(key, params.get(key))
    const existing = native.extensionWindow?.handle
    const open = existing && !existing.closed
    if (open && !reload) return { label: `ext-${engine}`, action: 'kept', url: url.href }
    const handle = window.open(url.href, `kimochi-ext-${engine}`)
    native.extensionWindow = { url: url.href, handle }
    if (!handle) {
      // A popup blocker: whoever drives the harness opens the URL itself (it is also in the log).
      console.warn('[harness] open the extension window by hand:', url.href)
      return { label: `ext-${engine}`, action: 'blocked', url: url.href }
    }
    return { label: `ext-${engine}`, action: open ? 'reloaded' : 'created', url: url.href }
  }

  const commands = extWindow
    ? { report, ext_relay: extRelay }
    : {
        storage_load: ({ extension } = {}) => JSON.parse(localStorage.getItem(storageKey(extension)) ?? '{}'),
        storage_save: ({ extension, value } = {}) => {
          localStorage.setItem(storageKey(extension), JSON.stringify(value))
          return null
        },
        // main.rs `storage_backup`: a copy beside the file (§5.4.1), answered with its name.
        storage_backup: ({ extension } = {}) => {
          const value = localStorage.getItem(storageKey(extension))
          if (value === null) return null
          const name = `chrome-local-${extension}.json.bak-${Date.now()}`
          localStorage.setItem(`kimochi.harness.${name}`, value)
          return name
        },
        report,
        window_bounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
        // ui/api-lookup.js (the Yomitan API pop-up), which the Yomitan path installs: Yomitan's own popup.
        settings_get: ({ key } = {}) => (key === 'yomitanSettings' ? { popupType: 'builtin' } : null),
        hide_popover: () => null,
        panel: (args) => {
          console.log('[harness] panel', args)
          // A `?window=dictionary` page plays the panel; the hub shows "it" and relays `navigate`.
          if (params.get('relay') === '1') return null
          throw Error('The harness has no native panels')
        },
        ext_relay: extRelay,
        extension_window_ensure: ensureExtensionWindow,
        // The captured source frame a mining screenshot shows (main.rs `capture_frame_source`):
        // a 16×9 red PNG standing in for the game. `?frame=none` answers as before any scan.
        capture_frame_source: ({ scan } = {}) => {
          native.captures.push({ scan: scan ?? null, at: Date.now() })
          if (params.get('frame') === 'none') return null
          return { id: 1, matched: false, url: HARNESS_FRAME }
        },
        retain_frame: () => true
      }

  window.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        const handler = commands[command]
        if (!handler) {
          throw Error(extWindow ? `invalid: ${command} is not available to an extension window` : `The harness does not mock ${command}`)
        }
        return handler(args)
      }
    },
    event: {
      listen: async (event, callback) => {
        if (!relay || event !== 'ext-relay') return () => {}
        relay.listeners.add(callback)
        // Native's listener is live once `listen` resolves; so is this one.
        await relay.open
        return () => relay.listeners.delete(callback)
      }
    }
  }

  // ---------------------------------------------------------------- plugin-http stand-in

  if (params.get('fetch') === 'proxy' && !window.__TAURI_INTERNALS__) {
    const chunkBytes = Math.max(1, Number(params.get('chunk')) || 16384)
    const ipcMs = Math.max(0, Number(params.get('ipc')) || 0)
    const resources = new Map()
    let nextRid = 1
    const http = (native.http = { calls: 0, requests: [], bytes: 0 })
    const pause = () => (ipcMs ? new Promise((resolve) => setTimeout(resolve, ipcMs)) : Promise.resolve())
    const httpCommands = {
      'plugin:http|fetch': ({ clientConfig }) => {
        const rid = nextRid++
        resources.set(rid, { kind: 'request', config: clientConfig, controller: new AbortController() })
        return rid
      },
      'plugin:http|fetch_cancel': ({ rid }) => {
        resources.get(rid)?.controller?.abort()
        return null
      },
      'plugin:http|fetch_send': async ({ rid }) => {
        const request = resources.get(rid)
        if (!request) throw Error('resource id is invalid')
        resources.delete(rid)
        const { method, url, headers, data } = request.config
        const response = await fetch(`/__kimochi/proxy?url=${encodeURIComponent(url)}`, {
          method,
          headers: { 'X-Kimochi-Forward-Headers': JSON.stringify(headers ?? []) },
          body: data ? new Uint8Array(data) : undefined,
          signal: request.controller.signal
        }).catch((error) => {
          throw request.controller.signal.aborted ? 'Request cancelled' : `error sending request for url (${url}): ${error.message}`
        })
        if (!response.headers.has('X-Kimochi-Status')) throw await response.text()
        const finalUrl = response.headers.get('X-Kimochi-Final-Url')
        http.requests.push({ url, finalUrl, status: Number(response.headers.get('X-Kimochi-Status')), at: Date.now() })
        const bodyRid = nextRid++
        resources.set(bodyRid, { kind: 'body', reader: response.body.getReader(), rest: null, controller: request.controller })
        return {
          status: Number(response.headers.get('X-Kimochi-Status')),
          statusText: decodeURIComponent(response.headers.get('X-Kimochi-Status-Text') ?? ''),
          url: finalUrl,
          headers: JSON.parse(decodeURIComponent(response.headers.get('X-Kimochi-Headers') ?? '[]')),
          rid: bodyRid
        }
      },
      'plugin:http|fetch_read_body': async ({ rid }) => {
        const body = resources.get(rid)
        if (!body) throw Error('resource id is invalid')
        if (!body.rest || body.rest.byteLength === 0) {
          const { done, value } = await body.reader.read()
          if (done) {
            resources.delete(rid)
            return new Uint8Array([1]).buffer
          }
          body.rest = value
        }
        const chunk = body.rest.subarray(0, chunkBytes)
        body.rest = body.rest.subarray(chunk.byteLength)
        http.bytes += chunk.byteLength
        const out = new Uint8Array(chunk.byteLength + 1)
        out.set(chunk)
        return out.buffer
      },
      'plugin:http|fetch_cancel_body': ({ rid }) => {
        const body = resources.get(rid)
        resources.delete(rid)
        void body?.reader?.cancel().catch(() => {})
        return null
      }
    }
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        const handler = httpCommands[command]
        if (!handler) throw Error(`The harness's plugin-http stand-in does not answer ${command}`)
        http.calls += 1
        await pause()
        return handler(args ?? {})
      },
      transformCallback: () => 0
    }
  }
})()
