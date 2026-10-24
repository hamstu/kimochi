/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/* global chrome:readonly */
/**
 * What both Yomitan hosts install identically (DICTIONARY_ENGINES.md §11.4): the backend-owning
 * overlay host (`overlay.js` → `dist/spike/shim.js`) and the relay client every other window runs
 * (`panel.js` → `dist/spike/panel-shim.js`). Each used to carry its own copy of all of this.
 *
 * Both hosts are trusted bundled code for Yomitan served at the app origin root, and both are
 * injected by native as document-start scripts for every frame (no module URL: dynamic imports
 * resolve against the document, see `assetUrl`).
 */
import { ChromeEvent, callbackApi, clone, platformInfo, resolveEngine, rethrow } from '../ext/primitives.js'
import { classifyLink, installDownloads, installFileDropGuard, installPageLinks, isExtensionPage } from '../page-actions.js'

/** The extension id every Yomitan context reports. Yomitan only checks that it is truthy. */
export const RUNTIME_ID = 'yomitan-spike'

/** The pages whose audio playback needs the clip-validity fix (see /spike/audio-bridge.js). */
const AUDIO_PAGES = ['/popup.html', '/search.html', '/settings.html']

/**
 * The top window of this frame when it is a frame of the app origin, else null: the Yomitan
 * hosts never install for a foreign frame (the root host owns the capability boundary), nor for
 * any engine but Yomitan (DICTIONARY_ENGINES.md §2: native injects the generic host into the
 * same windows, and exactly one of them installs).
 */
export function yomitanRoot(win) {
  if (resolveEngine(win) !== 'yomitan') return null
  if (!['tauri:', 'http:', 'https:', 'about:'].includes(win.location.protocol)) return null
  try {
    const root = win.top
    if (win.location.origin !== root.location.origin && win.location.href !== 'about:blank') return null
    return root
  } catch {
    return null
  }
}

/**
 * Absolute URL for a module a host loads itself. An injected script has no module URL of its
 * own, so a root-relative `import('/spike/...')` has nothing to resolve against and throws before
 * the request is ever made; resolving against the root document keeps both deliveries (injected,
 * and `<script src>`/`import` by a page) working. Every frame here is same-origin by
 * `yomitanRoot`.
 */
export const assetUrl = (root, path) => new URL(path, root.location.href).href

/** Events whose throwing listener propagates to the emitter, as the hosts' events always did. */
export const event = () => new ChromeEvent(rethrow)

/** `{api, unsupported}` with `lastError` on the installed `chrome.runtime`. */
export function apiForms(onUnsupported) {
  const { api } = callbackApi((value) => {
    if (value) chrome.runtime.lastError = value
    else delete chrome.runtime.lastError
  })
  const unsupported = (name) =>
    api(() => {
      throw Error(onUnsupported(name))
    })
  return { api, unsupported }
}

/**
 * A `chrome.runtime.Port` over one end of a MessageChannel, owned by a context (`owner.ports`)
 * so the context can hang up everything it holds when its document goes. Both ends of such a port
 * are in this window; ports to another window are the panel host's relay ports.
 */
export function channelPort(name, sender, native, owner) {
  const onMessage = event()
  const onDisconnect = event()
  let closed = false
  const hangUp = () => {
    closed = true
    native.close()
    owner.ports.delete(port)
    onDisconnect.emit(port)
  }
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
      hangUp()
    }
  }
  native.onmessage = ({ data }) => {
    if (data.disconnect) hangUp()
    else onMessage.emit(data.message, port)
  }
  owner.ports.add(port)
  return port
}

/**
 * The whole `chrome` object of one Yomitan context. What differs between the overlay and a
 * relayed window is passed in: how `runtime.sendMessage` and `tabs.sendMessage` reach their
 * targets, which tab this window is, where storage lives, and how an extension page is opened.
 */
export function createChrome({
  win,
  root,
  hub,
  ctx,
  events,
  tabId,
  api,
  unsupported,
  storage,
  sendMessage,
  tabsSendMessage
}) {
  const select = (id, frameId) => hub.select(id, frameId)
  const getURL = (p) => new URL(p.replace(/^\//, ''), new URL('/', root.location.href).href).href
  // Relative URLs resolve against the extension's root, where every Yomitan page is.
  const openTab = (url) => openExtensionUrl(hub, getURL(''), url)
  const info = () => platformInfo(win, root)
  return {
    // Tauri's Windows IPC uses WebView2's native chrome.webview bridge.
    ...(info().os === 'win' && win.chrome?.webview ? { webview: win.chrome.webview } : {}),
    runtime: {
      id: RUNTIME_ID,
      onMessage: events.onMessage,
      onConnect: events.onConnect,
      onInstalled: event(),
      getURL,
      getManifest: () => clone(hub.manifest),
      getPlatformInfo: api(() => info()),
      sendMessage: api(sendMessage),
      openOptionsPage: api(() => openTab(getURL('settings.html'))),
      connectNative: () => {
        throw Error('Native messaging is not implemented')
      }
    },
    storage: { local: storage('local'), session: storage('session'), onChanged: events.onChanged },
    tabs: {
      query: api(() => [{ id: tabId, windowId: 1, active: true, url: root.location.href }]),
      get: api(() => ({ id: tabId, windowId: 1, url: root.location.href })),
      getCurrent: api(() => ({ id: tabId, windowId: 1, url: win.location.href })),
      getZoom: api(() => 1),
      onZoomChange: event(),
      sendMessage: api(tabsSendMessage),
      connect(id, { frameId, name }) {
        const target = select(id, frameId)[0]
        if (!target) {
          if (root.__KIMOCHI_PLATFORM__?.os === 'linux' && hub.connectRemote)
            return hub.connectRemote({frameId, name, owner: ctx})
          throw Error(`Unknown frame ${frameId}`)
        }
        const channel = new MessageChannel()
        const sender = { frameId: ctx.id, tab: { id: tabId }, url: win.location.href }
        const local = channelPort(name, sender, channel.port1, ctx)
        const remote = channelPort(name, sender, channel.port2, target)
        target.events.onConnect.emit(remote)
        return local
      },
      create: api(({ url }) => openTab(url)),
      // `tabs.update(details)` (the current tab) as well as `tabs.update(id, details)`.
      update: api((id, details) => {
        if (id !== null && typeof id === 'object') details = id
        return details?.url ? openTab(details.url) : { id: tabId, windowId: 1, url: root.location.href }
      }),
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
          css = (await Promise.all(files.map((p) => win.fetch(getURL(p)).then((r) => r.text())))).join('\n')
        for (const c of select(target.tabId)) {
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
    i18n: { getUILanguage: () => win.navigator.language },
    windows: {
      create: unsupported('windows.create'),
      update: unsupported('windows.update'),
      get: api(() => ({ id: 1, focused: true }))
    }
  }
}

/**
 * `tabs.create`, `tabs.update` and `openOptionsPage`: a web page goes to the system browser and a
 * page of the extension to the dictionary window, both through `hub.open` (the overlay decides,
 * see ui/overlay.js `openDictionaryPage`). Anything else (`chrome://extensions/shortcuts`, which
 * Yomitan offers for its browser shortcuts) has nothing to open here and is dropped.
 */
export function openExtensionUrl(hub, base, url) {
  const { kind, url: href } = classifyLink(String(url ?? ''), base)
  if (kind === 'web' || kind === 'page') return hub.open(href)
  hub.log?.({ check: 'page-link-ignored', how: 'tabs', url: String(url).slice(0, 300) })
  return { id: -1, windowId: 1, url: String(url ?? '') }
}

/**
 * Links, `window.open`, downloads and file drops in one of Yomitan's own pages (settings, info,
 * search, popup…), see /host/page-actions.js. Kimochi's own documents (the overlay, the panels)
 * keep their own handling.
 */
export function installPageActions(win, root, hub, log) {
  if (!isExtensionPage(win)) return
  installPageLinks(win, { open: (url) => hub.open(url), log })
  installDownloads(win, { save: (file) => saveFile(root, file), log })
  installFileDropGuard(win)
}

/**
 * Hand a file a page is downloading to native (`ext_save_file`, the command Hachidori's and 10ten's
 * downloads use too), which asks where to save it. Answers `{saved, path?, bytes?}`.
 */
export function saveFile(root, { name, bytes }) {
  const invoke = root.__TAURI__?.core?.invoke
  if (!invoke) return Promise.reject(Error('Saving a file needs the Kimochi app'))
  return invoke('ext_save_file', new root.Uint8Array(bytes), {
    headers: { 'x-kimochi-filename': encodeURIComponent(String(name)) }
  })
}

export { installFileDropGuard }

/**
 * Install `chrome` and `browser`. The bundles are strict-mode code (ES modules), where assigning
 * to a read-only global throws instead of failing silently as the hand-written sloppy-mode shims
 * did, so a refused assignment falls back to redefining the property.
 */
export function installChrome(win, chromeApi) {
  for (const name of ['chrome', 'browser']) {
    try {
      win[name] = chromeApi
    } catch {
      // Defined below.
    }
    if (win[name] !== chromeApi) Object.defineProperty(win, name, { value: chromeApi, configurable: true, writable: true })
  }
}

/**
 * Yomitan picks its transport from `navigator.serviceWorker`: without it, it takes the
 * page-backend/MessagePort path that the backend iframe and the SharedWorker stub below serve,
 * instead of an MV3 service worker this host cannot provide.
 */
export function removeServiceWorker(win) {
  let proto = win.navigator
  while (proto) {
    if (Object.hasOwn(proto, 'serviceWorker')) delete proto.serviceWorker
    proto = Object.getPrototypeOf(proto)
  }
}

/**
 * Replace Yomitan's `SharedWorker('/js/comm/shared-worker-bridge.js')` with a MessageChannel.
 * `Application.main` hands the far end of `port` to what it believes is the backend bridge;
 * `onBridgeMessage({data, ports}, channel)` decides what the bridge does with each message.
 * Any other SharedWorker is the real one.
 */
export function stubSharedWorkerBridge(win, onBridgeMessage) {
  const NativeSharedWorker = win.SharedWorker
  win.SharedWorker = class {
    constructor(url, options) {
      if (new URL(url, win.location.href).pathname !== '/js/comm/shared-worker-bridge.js')
        return new NativeSharedWorker(url, options)
      const channel = new MessageChannel()
      this.port = channel.port1
      channel.port2.onmessage = (message) => onBridgeMessage(message, channel)
    }
  }
}

/**
 * The popup, search and settings pages play dictionary audio in this window; the "not available"
 * clip check is WebKit's to fix (see /spike/audio-bridge.js). Fetching stays the backend's.
 */
export function installAudioValidity(win, root, log) {
  if (!AUDIO_PAGES.includes(win.location.pathname)) return
  void import(assetUrl(root, '/spike/audio-bridge.js'))
    .then((m) => m.installAudioValidity(new URL('/js/media/audio-system.js', win.location.href).href))
    .catch((error) => log({ check: 'audio-bridge-failed', error: String(error?.message ?? error) }))
}

/** Linux: dictionary images WebKitGTK cannot decode natively (see /spike/linux-dictionary-images.js). */
export function installLinuxDictionaryImages(win, root, log, extra = {}) {
  if (win.__KIMOCHI_PLATFORM__?.os !== 'linux') return
  void import(assetUrl(root, '/spike/linux-dictionary-images.js'))
    .then(({ installLinuxDictionaryImages }) => installLinuxDictionaryImages(win))
    .catch((error) => log({ check: 'linux-dictionary-images-failed', error: String(error), ...extra }))
}

/** Linux: modifier-edge scan input for this document (see /spike/linux-scan-input.js). */
export function installLinuxScanInput(win, root, log, options, extra = {}) {
  void import(assetUrl(root, '/spike/linux-scan-input.js'))
    .then(({ installLinuxScanInput }) => installLinuxScanInput(win, options))
    .catch((error) => log({ check: 'linux-scan-input-failed', error: String(error), ...extra }))
}

/** A context's ports hang up, and it leaves the table, when its document goes. */
export function dropOnPagehide(win, hub, ctx) {
  win.addEventListener('pagehide', () => {
    for (const port of [...ctx.ports]) port.disconnect()
    hub.contexts.delete(ctx.id)
  })
}
