/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/* global chrome:readonly */
/**
 * Extension host for windows that must NOT own the Yomitan backend.
 *
 * Electron loaded the real extension into every native panel window
 * (src/main/index.ts passes `initYomitan` into NativeWindows), which is why its
 * log window has working dictionary lookup on scanned text. That cannot be done
 * here by standing up a second host: the backend owns the IndexedDB dictionary
 * database, and two owners of one database is a corruption risk.
 *
 * So this is a *client* host. The original frontend, scanner and popup run
 * locally; only genuinely backend-scoped calls are relayed to the overlay, which
 * holds the single real backend.
 *
 * ## What is NOT relayed, and why it matters
 *
 * Several of Yomitan's API calls are really frame routing wearing an API's
 * clothes. `frameInformationGet` asks "which frame am I?"; `broadcastTab` and
 * `sendMessageToFrame` ask the backend to deliver a message back into frames of
 * the *sender's own tab* — that is the frontend/popup handshake in
 * `js/comm/frame-endpoint.js`; and `openCrossFramePort` asks it to connect two
 * frames of that tab, which is how the host popup reaches the `Display` inside its
 * own iframe. Relaying those would ask the overlay's backend about the overlay's
 * frames, deliver the popup handshake to the wrong window, and — for the port —
 * fail outright, because the backend reads `sender.frameId` and a sender that
 * crossed a window boundary has none. They are therefore answered locally, with
 * this window's own frame ids, exactly as the backend would have.
 * `injectStylesheet` is local for the same reason.
 *
 * Whatever is answered here must use the same envelope the backend does:
 * `js/comm/api.js` reads `response.result`, so a bare return value resolves to
 * `undefined` at every call site.
 *
 * ## What relaying cannot carry
 *
 * `_pmInvoke` transfers a MessagePort, which cannot cross a window boundary. Its
 * only two callers are `registerOffscreenPort` and `connectToDatabaseWorker`,
 * connectToDatabaseWorker is answered locally by panel-media.js, fetching bytes
 * through the JSON relay for the original media renderer. registerOffscreenPort
 * remains unavailable because Chrome offscreen documents do not exist here.
 */
;(() => {
  if (window.__yomitanShim || window.__yomitanPanelShim) return
  if (!['tauri:', 'http:', 'https:', 'about:'].includes(location.protocol)) return

  let root
  try {
    root = top
    if (location.origin !== root.location.origin && location.href !== 'about:blank') return
  } catch {
    return
  }
  window.__yomitanPanelShim = true

  /**
   * `chrome.runtime.getPlatformInfo()`, from the platform the native side injects as
   * `__KIMOCHI_PLATFORM__` (`{os: 'macos' | 'windows' | 'linux', arch}`), else sniffed.
   */
  const platformInfo = () => {
    let injected = window.__KIMOCHI_PLATFORM__
    try {
      injected ??= root.__KIMOCHI_PLATFORM__
    } catch {
      // A detached root keeps the sniffed answer.
    }
    const OS = { macos: 'mac', mac: 'mac', windows: 'win', win: 'win', linux: 'linux' }
    const ARCH = {
      aarch64: 'arm64',
      arm64: 'arm64',
      x86_64: 'x86-64',
      'x86-64': 'x86-64',
      x86: 'x86-32',
      'x86-32': 'x86-32',
      arm: 'arm'
    }
    const os =
      OS[injected?.os] ??
      (/Mac/.test(navigator.platform) ? 'mac' : /Win/.test(navigator.platform) ? 'win' : 'linux')
    return { os, arch: ARCH[injected?.arch] ?? 'arm64' }
  }

  const tauri = root.__TAURI__
  const OVERLAY = 'overlay'

  /**
   * Absolute URL for a module this host loads itself.
   *
   * This file is delivered two ways: imported as a module by a page, and injected
   * by native as a document-start script for every frame. An injected script has no
   * module URL of its own, so a root-relative `import('/spike/...')` has nothing to
   * resolve against and throws before the request is ever made. Resolving against
   * the document keeps both deliveries working, and every frame here is same-origin
   * by the guard above.
   */
  const asset = (path) => new URL(path, root.location.href).href

  class ChromeEvent {
    listeners = new Set()
    addListener = (f) => this.listeners.add(f)
    removeListener = (f) => this.listeners.delete(f)
    hasListener = (f) => this.listeners.has(f)
    emit = (...args) => {
      for (const f of [...this.listeners]) f(...args)
    }
  }
  const clone = (v) => (v === undefined ? undefined : structuredClone(v))

  /**
   * Frame-id bands, injected by native before this script runs.
   *
   * Yomitan addresses a frame by a bare number, with the tab implied. That is fine
   * inside one browser tab and useless across native windows, where every window
   * would start at zero and "frame 0" would name three different documents. Each
   * window gets a band, so a frame id names exactly one frame on the desktop and the
   * port below knows which window to relay to.
   */
  const FRAME_BANDS = root.__kimochiFrameBands ?? {}
  const FRAME_BAND_SIZE = root.__kimochiFrameBandSize ?? 1000
  const windowForFrame = (frameId) =>
    Object.entries(FRAME_BANDS).find(
      ([, base]) => frameId >= base && frameId < base + FRAME_BAND_SIZE
    )?.[0] ?? null

  if (window === root) {
    let nextFrameId = root.__kimochiFrameBase ?? 0
    let nextRequest = 0
    let nextChannel = 0
    /** Ports whose other end is in another native window, by channel id. */
    const relayPorts = new Map()
    const pending = new Map()
    const awaitingNetwork = new Set()

    /**
     * A tab id distinct from the overlay's, derived from the window label, so a
     * backend that routes by tab id can never confuse two windows.
     */
    const label = root.__kimochiPanelLabel ?? location.pathname
    let tabId = 2
    for (const ch of label) tabId = ((tabId * 31 + ch.charCodeAt(0)) >>> 0) % 1000000 || 2
    if (tabId === 1) tabId = 2

    const hub = {
      contexts: new Map(),
      manifest: null,
      label,
      tabId,
      ready: null,
      networkReady: null,
      register(win, events) {
        const id = nextFrameId++
        const context = { id, win, events, ports: new Set(), background: false }
        this.contexts.set(id, context)
        return context
      },
      log(value) {
        console.log('[panel-host]', value)
        value = { at: Date.now(), ...value }
        // Panel windows have no devtools open during ordinary use, and a dictionary
        // that quietly fails to start is exactly the failure this has to surface, so
        // the record goes where the rest of the app's diagnostics go. Metadata only.
        void tauri?.core?.invoke('report', { value: { window: label, ...value } }).catch(() => {})
      },
      /** Ask the overlay's backend and wait for its answer. */
      async toBackend(message) {
        if (!tauri?.core) throw Error('Tauri core API unavailable; cannot reach the backend')
        const id = ++nextRequest
        const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
        await tauri.core.invoke('ext_relay', {
          target: OVERLAY,
          payload: { kind: 'request', id, message: clone(message) }
        })
        return Promise.race([
          answer,
          new Promise((_, reject) =>
            setTimeout(() => {
              pending.delete(id)
              reject(Error(`Backend relay timed out: ${message?.action}`))
            }, 30000)
          )
        ])
      },
      /** Deliver into this window's own frames: the frontend/popup path. */
      deliver(targets, message) {
        const sender = { id: 'yomitan-spike', tab: { id: hub.tabId }, url: root.location.href }
        let handled = false
        let done
        const response = new Promise((resolve) => {
          done = resolve
        })
        for (const target of targets) {
          for (const listener of [...target.events.onMessage.listeners]) {
            const value = listener(clone(message), clone(sender), (data) => {
              handled = true
              done(clone(data))
            })
            if (value === true) handled = true
            else if (value?.then) {
              handled = true
              value.then(done)
            }
          }
        }
        return handled ? response : undefined
      },
      select(id, frameId) {
        return [...this.contexts.values()].filter(
          (c) => id === hub.tabId && (frameId === undefined || frameId === c.id)
        )
      },
      open(url) {
        // Extension pages belong in their own window, which the overlay owns.
        void tauri?.core?.invoke('ext_relay', { target: OVERLAY, payload: { kind: 'open', url } })
        return { id: hub.tabId, windowId: 1, url }
      },
      /**
       * Answer the media drawing worker's database port from this window.
       *
       * Loaded on demand: a window that never shows a dictionary image never
       * pays for the adapter.
       */
      async serveMedia(port) {
        try {
          const { serveMedia } = await import(asset('/spike/panel-media.js'))
          serveMedia(port, {
            getMedia: (targets) => hub.toBackend({ action: 'getMedia', params: { targets } }),
            log: (value) => hub.log(value)
          })
          hub.log({ check: 'panel-media-connected' })
        } catch (error) {
          hub.log({
            check: 'panel-media-unavailable',
            error: String(error?.message ?? error),
            note: 'Dictionary text still works; images in this window will not render.'
          })
        }
      },
      /**
       * A `chrome.runtime.Port` whose other end is in another native window.
       *
       * A real MessagePort cannot cross a window boundary, but nothing sent over a
       * CrossFrameAPI port needs to: it carries `{type, id, data}` objects of plain
       * JSON — an action name, its parameters, and a dictionary result. So the port
       * is relayed as JSON over the same `ext_relay` command everything else uses,
       * and `CrossFrameAPIPort` cannot tell the difference.
       */
      relayPort({ channel, name, target, owner, sender }) {
        const onMessage = new ChromeEvent()
        const onDisconnect = new ChromeEvent()
        let closed = false
        const port = {
          name,
          sender,
          onMessage,
          onDisconnect,
          postMessage(message) {
            if (closed) throw Error('Disconnected port')
            void tauri?.core
              ?.invoke('ext_relay', {
                target,
                payload: { kind: 'port-message', channel, message: clone(message) }
              })
              .catch(() => port.disconnect())
          },
          disconnect() {
            if (closed) return
            closed = true
            relayPorts.delete(channel)
            void tauri?.core
              ?.invoke('ext_relay', { target, payload: { kind: 'port-close', channel } })
              .catch(() => {})
            onDisconnect.emit(port)
          },
          /** Called when the other window hangs up, so nothing is relayed back. */
          remoteClosed() {
            if (closed) return
            closed = true
            relayPorts.delete(channel)
            onDisconnect.emit(port)
          }
        }
        relayPorts.set(channel, port)
        owner.ports.add(port)
        return port
      },
      /**
       * Wait until the single backend in the overlay can answer a real question.
       *
       * A round trip that returns dictionary info proves the whole chain: the relay
       * command, the overlay window, its extension host and its backend. The retry is
       * for the startup transients — panels are created before the overlay, so an early
       * caller can find a backend that is still importing, or an overlay that is not
       * listening yet and drops the request. Each attempt is short so a dropped request
       * is retried promptly instead of consuming the whole deadline.
       */
      async waitForBackend(timeoutMs = 6000) {
        const within = (promise, ms, message) =>
          Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(Error(message)), ms))
          ])
        try {
          await within(hub.ready, timeoutMs, 'Extension host did not finish starting')
          const deadline = Date.now() + timeoutMs
          for (;;) {
            try {
              const reply = await within(
                hub.toBackend({ action: 'getDictionaryInfo', params: {} }),
                Math.max(1, Math.min(1500, deadline - Date.now())),
                'The overlay did not answer'
              )
              if (reply?.error) throw Error(reply.error.message ?? 'Dictionary lookup failed')
              return { ready: true }
            } catch (error) {
              const message = String(error?.message ?? error)
              const transient =
                message.includes('Dictionary backend is not ready') ||
                message.includes('The overlay did not answer')
              if (!transient || Date.now() >= deadline) throw error
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
          }
        } catch (error) {
          return { ready: false, error: String(error?.message ?? error) }
        }
      },
      /**
       * Whether this window is ready to serve other windows.
       *
       * Only the popup host sets it, and only once the original `PopupFactory` has
       * registered its handlers. Before that a client's `popupFactoryGetOrCreatePopup`
       * would time out and the client would quietly settle for a popup inside itself
       * for the rest of the session, because Yomitan caches that decision.
       */
      serving: false,
      /**
       * Wait for another window to be able to serve, within a bounded deadline.
       *
       * Windows come up in an order nobody controls, so this asks rather than sleeps,
       * and gives up rather than hanging: a caller that cannot wait any longer falls
       * back to something that works.
       */
      async waitForWindow(target, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const id = ++nextRequest
          const answer = new Promise((resolve) => pending.set(id, { resolve, reject: resolve }))
          void tauri?.core
            ?.invoke('ext_relay', { target, payload: { kind: 'ping', id } })
            .catch(() => {})
          const reply = await Promise.race([
            answer,
            new Promise((resolve) => setTimeout(() => resolve(null), 250))
          ])
          pending.delete(id)
          if (reply?.ready) return true
        }
        return false
      },
      /** A channel id unique to this window, so two windows cannot collide. */
      nextChannel(frameId) {
        return `${frameId}:${++nextChannel}`
      },
      /** Late-installed frames pick up the original network adapter here. */
      installPending() {
        for (const win of awaitingNetwork) hub.installNetwork?.(win)
        awaitingNetwork.clear()
      },
      awaitNetwork(win) {
        awaitingNetwork.add(win)
      },
      settle(payload, from) {
        if (payload.kind === 'response') {
          const entry = pending.get(payload.id)
          if (!entry) return
          pending.delete(payload.id)
          if (payload.error) entry.reject(Error(payload.error))
          else entry.resolve(payload.result)
        } else if (payload.kind === 'broadcast') {
          hub.deliver([...hub.contexts.values()], payload.message)
        } else if (payload.kind === 'storage-changed') {
          // Reads and writes are relayed; without this, a setting changed in
          // another window would be invisible to code here that watches for it.
          for (const context of hub.contexts.values()) {
            context.events.onChanged.emit(payload.changes, payload.area)
          }
        } else if (payload.kind === 'port-open') {
          const target = [...hub.contexts.values()].find((c) => c.id === payload.toFrameId)
          if (!target) return
          const port = hub.relayPort({
            channel: payload.channel,
            // Named with the *other* end's identity: that is what CrossFrameAPI
            // files the port under, and it is how the reply finds its way back.
            name: JSON.stringify({
              name: 'cross-frame-communication-port',
              otherTabId: payload.fromTabId,
              otherFrameId: payload.fromFrameId
            }),
            target: payload.fromWindow,
            owner: target,
            sender: { frameId: payload.fromFrameId, tab: { id: payload.fromTabId } }
          })
          target.events.onConnect.emit(port)
        } else if (payload.kind === 'port-message') {
          const port = relayPorts.get(payload.channel)
          port?.onMessage.emit(payload.message, port)
        } else if (payload.kind === 'port-close') {
          relayPorts.get(payload.channel)?.remoteClosed()
        } else if (payload.kind === 'ping') {
          // Answered by every window, so one window can wait for another to be usable
          // instead of guessing. Targeted, never broadcast.
          void tauri?.core?.invoke('ext_relay', {
            target: from,
            payload: { kind: 'pong', id: payload.id, ready: hub.serving }
          })
        } else if (payload.kind === 'pong') {
          pending.get(payload.id)?.resolve(payload)
          pending.delete(payload.id)
        } else if (payload.kind === 'navigate' && payload.url) {
          const next = new URL(payload.url, root.location.href)
          if (next.origin === root.location.origin && next.href !== root.location.href) {
            root.location.href = next.href
          }
        }
      }
    }
    root.__extensionHost = hub

    // The original network adapter — the one the dictionary-download and
    // AnkiConnect paths were proven against — must be in place before any
    // extension module issues a request, so it is loaded first and every frame
    // registered before it lands is upgraded the moment it does.
    hub.networkReady = import(asset('/spike/network-bundle.js'))
      .then(() => hub.installPending())
      .catch((error) => {
        hub.log({ check: 'panel-network-adapter-failed', error: String(error?.message ?? error) })
      })

    hub.ready = (async () => {
      hub.manifest = await fetch('/manifest.json').then((r) => r.json())
      if (tauri?.event?.listen) {
        // Native stamps a per-sender sequence. Event delivery is not guaranteed to be
        // exactly-once, and a cross-frame port is not idempotent: a redelivered
        // acknowledgement fails the whole invocation with "already acknowledged", and
        // a redelivered backend broadcast fires every listener twice.
        const seen = new Map()
        await tauri.event.listen('ext-relay', ({ payload }) => {
          if (!payload?.payload) return
          const { from, to, seq } = payload
          // Addressed to another window, or back to this one: the JS listener takes
          // every emit regardless of target, so this is the only filter there is.
          if (from === hub.label) return
          if (typeof to === 'string' && to !== hub.label) return
          if (typeof seq === 'number' && typeof from === 'string') {
            if (seq <= (seen.get(from) ?? 0)) {
              hub.log({ check: 'relay-duplicate', from, seq })
              return
            }
            seen.set(from, seq)
          }
          hub.settle(payload.payload, from)
        })
      }
      await tauri?.core
        ?.invoke('ext_relay', { target: OVERLAY, payload: { kind: 'hello' } })
        .catch(() => {})
      await hub.networkReady
    })()
  }

  const hub = root.__extensionHost
  if (!hub) return

  const events = {
    onMessage: new ChromeEvent(),
    onConnect: new ChromeEvent(),
    onChanged: new ChromeEvent()
  }
  const ctx = hub.register(window, events)

  // Install the original adapter now if it has loaded, and otherwise queue this
  // frame and hold outgoing fetches until it does, rather than letting an early
  // request escape through the unadapted path.
  if (hub.installNetwork) {
    hub.installNetwork(window)
  } else {
    hub.awaitNetwork(window)
    // Preserve the real fetch before installing a deferred wrapper. The network
    // adapter must never capture that wrapper as its local transport.
    const nativeFetch = (window.__spikeNativeFetch ??= window.fetch.bind(window))
    window.fetch = (input, init) =>
      hub.networkReady.then(() =>
        window.fetch === undefined || window.fetch.__deferred
          ? nativeFetch(input, init)
          : window.fetch(input, init)
      )
    window.fetch.__deferred = true
  }

  const event = () => new ChromeEvent()
  const finish = (promise, cb) => {
    if (typeof cb !== 'function') return promise
    promise.then(
      (value) => cb(value),
      (error) => {
        chrome.runtime.lastError = { message: String(error.message ?? error) }
        try {
          cb()
        } finally {
          delete chrome.runtime.lastError
        }
      }
    )
    return undefined
  }
  const api =
    (fn) =>
    (...args) => {
      const cb = typeof args.at(-1) === 'function' ? args.pop() : undefined
      return finish(
        Promise.resolve().then(() => fn(...args)),
        cb
      )
    }
  const unsupported = (name) =>
    api(() => {
      throw Error(`${name} is not available in a relayed Kimochi window`)
    })

  /**
   * Frame-scoped calls answered here instead of at the backend.
   *
   * Each mirrors what `js/background/backend.js` would have done, but against
   * this window's frames: the backend stamps the sender's frame id onto the
   * message before forwarding it to the tab, and the popup handshake depends on
   * that stamp to know who to answer.
   */
  async function local(action, params) {
    switch (action) {
      case 'frameInformationGet':
        return { tabId: hub.tabId, frameId: ctx.id }
      case 'broadcastTab':
        hub.deliver([...hub.contexts.values()], { ...params.message, frameId: ctx.id })
        return true
      case 'sendMessageToFrame':
        hub.deliver(hub.select(hub.tabId, params.frameId), {
          ...params.message,
          frameId: ctx.id
        })
        return true
      case 'openCrossFramePort': {
        // The host popup talks to the Display inside its own iframe over a
        // CrossFrameAPI port, and a port is opened by asking the backend to connect
        // both ends. Relayed, that asks the *overlay's* backend, which reads
        // `sender.frameId` off a sender that crossed a window boundary and has none
        // — "Port does not have an associated frame ID". The popup then failed to
        // configure, `_invokeSafe` rethrew, and injection failed: the scanner
        // highlighted the word and no popup ever appeared.
        //
        // So it is answered here, against this window's own frames, exactly as
        // `_onApiOpenCrossFramePort` would: one port for each end, each named with
        // the *other* end's identity, and both delivered before this call resolves,
        // because `_createCommPort` looks the port up the moment it returns.
        const { targetTabId, targetFrameId } = params
        const named = (otherTabId, otherFrameId) =>
          JSON.stringify({ name: 'cross-frame-communication-port', otherTabId, otherFrameId })
        const target = hub.select(hub.tabId, targetFrameId)[0]
        if (target) {
          const identity = (context) => ({
            frameId: context.id,
            tab: { id: hub.tabId },
            url: context.win.location.href
          })
          const channel = new MessageChannel()
          ctx.events.onConnect.emit(
            makePort(named(hub.tabId, targetFrameId), identity(target), channel.port1, ctx)
          )
          target.events.onConnect.emit(
            makePort(named(hub.tabId, ctx.id), identity(ctx), channel.port2, target)
          )
          return true
        }

        // Not a frame of this window. The dictionary popup lives in its own native
        // window, so the frame being addressed may genuinely be somewhere else on the
        // desktop; the frame-id band says where.
        const remote = windowForFrame(targetFrameId)
        if (!remote || remote === hub.label) throw Error(`Unknown frame ${targetFrameId}`)
        const channel = hub.nextChannel(ctx.id)
        ctx.events.onConnect.emit(
          hub.relayPort({
            channel,
            name: named(targetTabId, targetFrameId),
            target: remote,
            owner: ctx,
            sender: { frameId: targetFrameId, tab: { id: targetTabId } }
          })
        )
        // Ordered after the local end, and before any message can be sent on it,
        // because `ext_relay` delivers in order and the caller has not returned yet.
        await tauri?.core?.invoke('ext_relay', {
          target: remote,
          payload: {
            kind: 'port-open',
            channel,
            toFrameId: targetFrameId,
            fromTabId: hub.tabId,
            fromFrameId: ctx.id,
            fromWindow: hub.label
          }
        })
        return true
      }
      case 'injectStylesheet': {
        const css =
          params.type === 'file'
            ? await fetch(chrome.runtime.getURL(params.value)).then((r) => r.text())
            : params.value
        const style = document.createElement('style')
        style.textContent = css
        document.head.append(style)
        return true
      }
      default:
        return undefined
    }
  }
  const LOCAL_ACTIONS = new Set([
    'frameInformationGet',
    'broadcastTab',
    'sendMessageToFrame',
    'openCrossFramePort',
    'injectStylesheet'
  ])

  /** chrome.storage is the backend's own store; relay rather than fork it. */
  function storage(area) {
    const call = (action, params) =>
      hub.toBackend({ action: '__storage', params: { area, action, ...params } })
    return {
      get: api((keys) => call('get', { keys: clone(keys) ?? null })),
      set: api((values) => call('set', { values: clone(values) })),
      remove: api((keys) => call('remove', { keys: clone(keys) })),
      clear: api(() => call('clear', {})),
      getBytesInUse: api(() => call('getBytesInUse', {})),
      onChanged: events.onChanged
    }
  }

  function makePort(name, sender, native, owner) {
    const onMessage = event()
    const onDisconnect = event()
    let closed = false
    const port = {
      name,
      sender,
      onMessage,
      onDisconnect,
      postMessage(message) {
        if (closed) throw Error('Disconnected port')
        native.postMessage({ message })
      },
      disconnect() {
        if (closed) return
        native.postMessage({ disconnect: true })
        closed = true
        native.close()
        owner.ports.delete(port)
        onDisconnect.emit(port)
      }
    }
    native.onmessage = ({ data }) => {
      if (data.disconnect) {
        closed = true
        native.close()
        owner.ports.delete(port)
        onDisconnect.emit(port)
      } else onMessage.emit(data.message, port)
    }
    owner.ports.add(port)
    return port
  }

  window.chrome = {
    // Tauri's Windows IPC uses WebView2's native chrome.webview bridge.
    ...(platformInfo().os === 'win' && window.chrome?.webview
      ? { webview: window.chrome.webview }
      : {}),
    runtime: {
      id: 'yomitan-spike',
      onMessage: events.onMessage,
      onConnect: events.onConnect,
      onInstalled: event(),
      getURL: (p) => new URL(p.replace(/^\//, ''), new URL('/', root.location.href).href).href,
      getManifest: () => clone(hub.manifest),
      getPlatformInfo: api(() => platformInfo()),
      sendMessage: api(async (message) => {
        // `js/comm/api.js` reads `response.result`, so a locally answered call has to
        // be wrapped exactly as the backend wraps a relayed one. Returning the bare
        // value made `frameInformationGet` resolve to undefined, which killed
        // `Application.main` at its first line — and because
        // `content-script-wrapper.js` starts the frontend in a floating async IIFE,
        // that failure never reached the caller: the window went on reporting the
        // dictionary as ready while nothing in it could ever look a word up.
        if (LOCAL_ACTIONS.has(message?.action)) {
          return { result: await local(message.action, message.params ?? {}) }
        }
        await hub.ready
        return hub.toBackend(message)
      }),
      openOptionsPage: api(() => hub.open('/settings.html')),
      connectNative: () => {
        throw Error('Native messaging is not implemented')
      }
    },
    storage: { local: storage('local'), session: storage('session'), onChanged: events.onChanged },
    tabs: {
      query: api(() => [{ id: hub.tabId, windowId: 1, active: true, url: root.location.href }]),
      get: api(() => ({ id: hub.tabId, windowId: 1, url: root.location.href })),
      getCurrent: api(() => ({ id: hub.tabId, windowId: 1, url: location.href })),
      getZoom: api(() => 1),
      onZoomChange: event(),
      // Frame-to-frame traffic (frontend <-> popup) stays inside this window.
      sendMessage: api((id, message, options = {}) =>
        hub.deliver(hub.select(id, options.frameId), message)
      ),
      connect(id, { frameId, name }) {
        const target = hub.select(id, frameId)[0]
        if (!target) throw Error(`Unknown frame ${frameId}`)
        const channel = new MessageChannel()
        const sender = { frameId: ctx.id, tab: { id: hub.tabId }, url: location.href }
        const localPort = makePort(name, sender, channel.port1, ctx)
        const remote = makePort(name, sender, channel.port2, target)
        target.events.onConnect.emit(remote)
        return localPort
      },
      create: api(({ url }) => hub.open(url)),
      update: api((id, details) => (details?.url ? hub.open(details.url) : { id: hub.tabId })),
      remove: unsupported('tabs.remove'),
      captureVisibleTab: unsupported('tabs.captureVisibleTab')
    },
    permissions: {
      getAll: api(() => ({ permissions: ['storage', 'unlimitedStorage'], origins: [] })),
      contains: api(
        ({ permissions = [], origins = [] }) =>
          !origins.length && permissions.every((p) => ['storage', 'unlimitedStorage'].includes(p))
      ),
      request: api(() => false),
      remove: api(() => false),
      onAdded: event(),
      onRemoved: event()
    },
    action: {
      setBadgeText: api(() => {}),
      setBadgeBackgroundColor: api(() => {}),
      setTitle: api(() => {})
    },
    commands: { getAll: api(() => []), onCommand: event() },
    contextMenus: { create: () => {}, remove: api(() => {}), onClicked: event() },
    scripting: {
      getRegisteredContentScripts: api(() => []),
      registerContentScripts: unsupported('scripting.registerContentScripts'),
      unregisterContentScripts: api(() => {}),
      insertCSS: api(async ({ target, css, files }) => {
        if (files)
          css = (
            await Promise.all(
              files.map((p) => fetch(chrome.runtime.getURL(p)).then((r) => r.text()))
            )
          ).join('\n')
        for (const c of hub.select(target.tabId)) {
          if (!target.allFrames && target.frameIds && !target.frameIds.includes(c.id)) continue
          const style = c.win.document.createElement('style')
          style.textContent = css
          c.win.document.head.append(style)
        }
      })
    },
    declarativeNetRequest: {
      getDynamicRules: api(() => []),
      getSessionRules: api(() => []),
      // Backend-scoped: the overlay's backend makes the requests (see host/shim.js).
      updateDynamicRules: api(() => {}),
      updateSessionRules: api(() => {})
    },
    extension: {
      isAllowedFileSchemeAccess: api(() => false),
      isAllowedIncognitoAccess: api(() => false)
    },
    i18n: { getUILanguage: () => navigator.language },
    windows: {
      create: unsupported('windows.create'),
      update: unsupported('windows.update'),
      get: api(() => ({ id: 1, focused: true }))
    }
  }
  window.browser = window.chrome

  // Yomitan picks its transport from these. Removing the service worker takes the
  // MessagePort branch; the stub below lets that branch complete without a
  // backend in this window, and the resulting port only ever carries media
  // drawing, which is fire-and-forget.
  let proto = navigator
  while (proto) {
    if (Object.hasOwn(proto, 'serviceWorker')) delete proto.serviceWorker
    proto = Object.getPrototypeOf(proto)
  }
  const NativeSharedWorker = window.SharedWorker
  window.SharedWorker = class {
    constructor(url, options) {
      if (new URL(url, location.href).pathname !== '/js/comm/shared-worker-bridge.js')
        return new NativeSharedWorker(url, options)
      // `Application.main` hands the far end of this channel to what it believes
      // is the backend. Nothing here forwards it anywhere — the only message
      // that arrives carrying a port is the media drawing worker's database
      // connection, and both ends of that are inside this window, so it is
      // answered locally rather than dropped.
      const channel = new MessageChannel()
      this.port = channel.port1
      channel.port2.onmessage = ({ data, ports }) => {
        if (data?.action === 'connectToDatabaseWorker' && ports?.[0]) {
          void hub.serveMedia(ports[0])
        }
        // `registerOffscreenPort` is Chrome's offscreen document, which does not
        // exist here; its port is simply never answered, as before.
      }
    }
  }

  // The popup plays its audio here; the "not available" clip check is WebKit's to fix
  // (see /spike/audio-bridge.js). Fetching is the backend's, in the overlay.
  if (['/popup.html', '/search.html', '/settings.html'].includes(location.pathname))
    void import(asset('/spike/audio-bridge.js'))
      .then((m) => m.installAudioValidity(new URL('/js/media/audio-system.js', location.href).href))
      .catch((error) =>
        hub.log({ check: 'audio-bridge-failed', error: String(error?.message ?? error) })
      )

  window.addEventListener('pagehide', () => {
    for (const port of [...ctx.ports]) port.disconnect()
    hub.contexts.delete(ctx.id)
  })
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux') {
    void import(asset('/spike/linux-dictionary-images.js'))
      .then(({ installLinuxDictionaryImages }) => installLinuxDictionaryImages(window))
      .catch(error => hub.log({ check: 'linux-dictionary-images-failed', error: String(error) }))
    // A long touch can create a separate GTK context-menu surface. Gamescope
    // cannot present that surface reliably, while its native grab blocks the UI.
    void tauri.core.invoke('platform_capabilities').then(caps => {
      if (caps.session.nativeGamescope) {
        document.addEventListener('contextmenu', event => event.preventDefault())
      }
    }).catch(error => hub.log({ check: 'gamescope-context-menu-failed', error: String(error) }))
    // Settings previews and nested dictionary frames do not call host.start().
    // Give every Linux Yomitan document the same modifier-edge handling.
    if (platformInfo().os === 'linux' && hub.label === 'popup-host' && window !== root) {
      void import(asset('/spike/linux-popup-document.js'))
        .then(({ installLinuxPopupDocument }) => installLinuxPopupDocument(window))
        .catch(error => hub.log({ check: 'linux-popup-document-failed', error: String(error) }))
    }
    void import(asset('/spike/linux-scan-input.js'))
      .then(({ installLinuxScanInput }) => installLinuxScanInput(window, {
        passive: ['overlay', 'popup-host'].includes(hub.label)
      }))
      .catch(error => hub.log({ check: 'linux-scan-input-failed', error: String(error) }))
  }
  window.addEventListener('error', (e) =>
    hub.log({ check: 'panel-error', error: e.message, file: e.filename, line: e.lineno })
  )
  // The dictionary path is almost entirely promises. A rejection nobody handles is
  // exactly the failure that used to look like "hovering just does nothing", so it
  // is reported rather than left in a console no one has open.
  window.addEventListener('unhandledrejection', (e) =>
    hub.log({
      check: 'panel-rejection',
      frame: window === root ? 'top' : location.pathname,
      error: String(e.reason?.message ?? e.reason)
    })
  )

  /**
   * Start the original Yomitan frontend in this window.
   *
   * Only the top frame publishes this. The shim also installs into the popup's
   * iframe, and if every frame assigned here the last one to load would win and
   * the page would end up starting the frontend inside the popup instead of in
   * the document that owns the text.
   *
   * Called once the page's own content is in the DOM: the scanner walks real text
   * nodes, so there is nothing to scan before then.
   */
  if (window === root) {
    /**
     * Where this window's popup should be rendered, if not inside itself.
     *
     * Native decides: it owns the window list, and whether a window's popup is
     * cramped is a fact about that window. Absent for windows whose popup belongs
     * where it is — the Yomitan settings page previews its popup on purpose.
     */
    const popupHost = root.__kimochiPopupHost
    let remotePopup =
      popupHost && typeof FRAME_BANDS[popupHost] === 'number' && popupHost !== hub.label
        ? {
            frameId: FRAME_BANDS[popupHost],
            async offset() {
              const bounds = await tauri.core.invoke('window_bounds')
              return [bounds.x, bounds.y]
            }
          }
        : null

    /**
     * Close the popup when the reader clicks away from the whole app.
     *
     * A popup inside its own window keeps its scanner here, where a `mousedown` on
     * this window still closes it. What no longer reaches this window is a click on
     * the desktop or on another application, and native already knows about those: it
     * counts a press that no window claims, which excludes the popup's own window and
     * every word the overlay drew. Yomitan closes on `pointerdown`, so that is what a
     * count going up is turned into.
     */
    async function watchOutsideClicks() {
      let seen = null
      if (platformInfo().os === 'linux') {
        await tauri?.event?.listen('gnome-popup-dismiss', () => root.dispatchEvent(
          new PointerEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
        ))
      }
      await tauri?.event?.listen('state', ({ payload }) => {
        const count = payload?.dismiss
        if (typeof count !== 'number') return
        if (seen === null || count === seen) {
          seen = count
          return
        }
        seen = count
        root.dispatchEvent(
          new PointerEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
        )
      })
    }

    root.__kimochiPanelYomitan = {
      hub,
      async start() {
        await hub.ready
        if (window.__KIMOCHI_PLATFORM__?.os === 'linux') {
          const caps = await tauri.core.invoke('platform_capabilities')
          // Wayland exposes no toplevel origin. Keep anchors and popups in the
          // same coordinate space instead of treating (0,0) as a desktop origin.
          if (caps.session.nativeGamescope) remotePopup = null
          if (caps.session.backend === 'wayland') {
            const gnome = await tauri.core.invoke('gnome_overlay', { operation: 'status', payload: null })
            if (!gnome.available || !gnome.desktopPopup) remotePopup = null
          }
        }
        // Before the frontend, so no popup can be built without being seen. This is
        // the only record of whether a lookup produced a popup: these windows are
        // capture-protected, so a screenshot cannot answer it.
        const { observePopups } = await import(asset('/spike/popup-bridge.js'))
        const observed = await observePopups({
          log: (value) => hub.log(value),
          window: hub.label,
          remote: remotePopup
        })
        if (platformInfo().os === 'win') {
          const { installWindowsPointer } = await import(asset('/spike/windows-pointer.js'))
          await installWindowsPointer(root, () => observed.popups)
        }
        if (window.__KIMOCHI_PLATFORM__?.os === 'linux') {
          const { installLinuxScanInput } = await import(asset('/spike/linux-scan-input.js'))
          await installLinuxScanInput(root)
        }
        if (remotePopup && !(await hub.waitForWindow(popupHost, 30000))) {
          // Yomitan caches which popup a frontend uses, so starting before the host
          // can answer would settle for a popup inside this window for the rest of
          // the session. Said out loud rather than left as a mystery.
          hub.log({ check: 'popup-host-unavailable', target: popupHost })
        }
        await import(chrome.runtime.getURL('js/app/content-script-wrapper.js'))
        if (remotePopup) await watchOutsideClicks()
        hub.log({ check: 'panel-frontend-started', remotePopup: remotePopup?.frameId ?? null })
      }
    }
  }
})()
