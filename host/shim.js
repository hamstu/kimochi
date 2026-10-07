/* eslint @typescript-eslint/explicit-function-return-type: "off" -- This standalone spike runs plain JavaScript without a TypeScript build. */
/* global chrome:readonly */
/* Throwaway, Yomitan-specific extension host. Trusted bundled pages only. */
;(() => {
  if (window.__yomitanShim || !['tauri:', 'http:', 'https:', 'about:'].includes(location.protocol))
    return
  // The root host owns the capability boundary; no shims for foreign frames.
  let root
  try {
    root = top
    if (location.origin !== root.location.origin && location.href !== 'about:blank') return
  } catch {
    return
  }
  window.__yomitanShim = true

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
  if (window === root) {
    let nextId = 0
    root.__extensionHost = {
      contexts: new Map(),
      local: {},
      session: {},
      writes: Promise.resolve(),
      manifest: null,
      bridgePort: null,
      register(win, events) {
        const id = nextId++
        const context = {
          id,
          win,
          events,
          ports: new Set(),
          background: win.location.pathname === '/spike/background.html'
        }
        this.contexts.set(id, context)
        return context
      },
      log(value) {
        const safe = JSON.parse(JSON.stringify({ at: Date.now(), ...value }))
        console.log('[host]', safe)
        root.dispatchEvent(new CustomEvent('spike-log', { detail: safe }))
        root.__TAURI__?.core.invoke('report', { value: safe }).catch(console.error)
      },
      async message(from, targets, message) {
        const sender = {
          id: 'yomitan-spike',
          url: from.win.location.href,
          origin: from.win.location.origin,
          frameId: from.id,
          tab: { id: 1, windowId: 1, url: root.location.href }
        }
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
        if (!handled) return undefined
        return await Promise.race([
          response,
          new Promise((_, reject) => {
            const t = setTimeout(() => reject(Error(`Message timed out: ${message.action}`)), 30000)
            response.finally(() => clearTimeout(t))
          })
        ])
      },
      select(tabId, frameId) {
        return [...this.contexts.values()].filter(
          (c) => !c.background && tabId === 1 && (frameId === undefined || frameId === c.id)
        )
      },
      open(url) {
        const parsed = new URL(url, root.location.href)
        if (parsed.origin !== root.location.origin)
          throw Error('External navigation is not implemented in this spike')
        root.document.querySelector('#extension-page').src = parsed.href
        return { id: 1, windowId: 1, url: parsed.href }
      }
    }
  }
  const hub = root.__extensionHost
  if (!hub) return
  const events = {
    onMessage: new ChromeEvent(),
    onConnect: new ChromeEvent(),
    onChanged: new ChromeEvent()
  }
  const ctx = hub.register(window, events)
  hub.installNetwork?.(window)
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
      hub.log({ unsupported: name })
      throw Error(`${name} is not implemented in this spike`)
    })
  function storage(area) {
    const mutate = (fn) =>
      (hub.writes = hub.writes
        .catch(() => {})
        .then(async () => {
          const previous = clone(hub[area])
          fn(hub[area])
          try {
            if (area === 'local')
              await root.__TAURI__.core.invoke('storage_save', { value: hub.local })
          } catch (e) {
            hub[area] = previous
            throw e
          }
          const changes = {}
          for (const key of new Set([...Object.keys(previous), ...Object.keys(hub[area])])) {
            if (JSON.stringify(previous[key]) !== JSON.stringify(hub[area][key]))
              changes[key] = { oldValue: previous[key], newValue: clone(hub[area][key]) }
          }
          for (const c of hub.contexts.values()) c.events.onChanged.emit(clone(changes), area)
        }))
    return {
      get: api(async (keys) => {
        await hub.writes
        const data = hub[area]
        if (keys == null) return clone(data)
        if (typeof keys === 'string') keys = [keys]
        if (Array.isArray(keys))
          return clone(Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])))
        return clone(
          Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in data ? data[k] : v]))
        )
      }),
      set: api((values) => mutate((data) => Object.assign(data, clone(values)))),
      remove: api((keys) =>
        mutate((data) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]
        })
      ),
      clear: api(() =>
        mutate((data) => {
          for (const k of Object.keys(data)) delete data[k]
        })
      ),
      getBytesInUse: api(() => new TextEncoder().encode(JSON.stringify(hub[area])).length),
      onChanged: events.onChanged
    }
  }
  function makePort(name, sender, native, owner) {
    const onMessage = event(),
      onDisconnect = event()
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
      sendMessage: api((message) =>
        hub.message(
          ctx,
          [...hub.contexts.values()].filter((c) => c !== ctx && (ctx.background || c.background)),
          message
        )
      ),
      openOptionsPage: api(() => hub.open('/settings.html')),
      connectNative: () => {
        throw Error('Native messaging is not implemented in this spike')
      }
    },
    storage: { local: storage('local'), session: storage('session'), onChanged: events.onChanged },
    tabs: {
      query: api(() => [{ id: 1, windowId: 1, active: true, url: root.location.href }]),
      get: api(() => ({ id: 1, windowId: 1, url: root.location.href })),
      getCurrent: api(() => ({ id: 1, windowId: 1, url: location.href })),
      getZoom: api(() => 1),
      onZoomChange: event(),
      sendMessage: api((id, message, options = {}) =>
        hub.message(ctx, hub.select(id, options.frameId), message)
      ),
      connect(id, { frameId, name }) {
        const target = hub.select(id, frameId)[0]
        if (!target) throw Error(`Unknown frame ${frameId}`)
        const channel = new MessageChannel()
        const sender = { frameId: ctx.id, tab: { id: 1 }, url: location.href }
        const local = makePort(name, sender, channel.port1, ctx)
        const remote = makePort(name, sender, channel.port2, target)
        target.events.onConnect.emit(remote)
        return local
      },
      create: api(({ url }) => hub.open(url)),
      update: api((id, details) => (details?.url ? hub.open(details.url) : { id: 1 })),
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
      // Yomitan sets header rules around `fetchAnonymous` (strip cookies, set Origin). The
      // backend's cross-origin requests go through native code instead (audio-bridge.js),
      // which sends no cookies and no page Origin, so the rules have nothing left to do;
      // refusing them made every such request fail before it was sent.
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
  // Use Yomitan's existing page-backend/MessagePort path instead of MV3 service workers.
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
      const channel = new MessageChannel()
      this.port = channel.port1
      channel.port2.onmessage = ({ data, ports }) => {
        if (data.action === 'registerBackendPort') hub.bridgePort = channel.port2
        else if (data.action === 'connectToBackend1') {
          if (!hub.bridgePort) throw Error('Background bridge is not ready')
          hub.bridgePort.postMessage(null, [ports[0]])
          channel.port2.close()
        }
      }
    }
  }
  // Dictionary audio the way an extension gets it: see /spike/audio-bridge.js.
  const audioBridge = () => import(new URL('/spike/audio-bridge.js', root.location.href).href)
  const audioBridgeFailed = (error) =>
    hub.log({ check: 'audio-bridge-failed', error: String(error?.message ?? error) })
  if (ctx.background)
    void audioBridge()
      .then((m) =>
        m.installBackendFetch(
          (command, args) => root.__TAURI__.core.invoke(command, args),
          (value) => hub.log(value)
        )
      )
      .catch(audioBridgeFailed)
  if (['/popup.html', '/search.html', '/settings.html'].includes(location.pathname))
    void audioBridge()
      .then((m) => m.installAudioValidity(new URL('/js/media/audio-system.js', location.href).href))
      .catch(audioBridgeFailed)
  window.addEventListener('pagehide', () => {
    for (const port of [...ctx.ports]) port.disconnect()
    hub.contexts.delete(ctx.id)
  })
  window.addEventListener('error', (e) =>
    hub.log({
      error: e.message,
      file: e.filename,
      line: e.lineno,
      stack: e.error?.stack,
      frame: ctx.id
    })
  )
  window.addEventListener('unhandledrejection', (e) =>
    hub.log({ error: String(e.reason), stack: e.reason?.stack, frame: ctx.id })
  )
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux') {
    void import(new URL('/spike/linux-dictionary-images.js', root.location.href).href)
      .then(({ installLinuxDictionaryImages }) => installLinuxDictionaryImages(window))
      .catch(error => hub.log({ check: 'linux-dictionary-images-failed', error: String(error), frame: ctx.id }))
  }
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && window !== root) {
    void import(new URL('/spike/linux-scan-input.js', root.location.href).href)
      .then(({ installLinuxScanInput }) => installLinuxScanInput(window, { passive: true }))
      .catch(error => hub.log({ check: 'linux-scan-input-failed', error: String(error), frame: ctx.id }))
  }
})()
