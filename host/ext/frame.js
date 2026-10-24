/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * An extension-origin document: the background host page, the offscreen document, or an
 * extension page (options, Hachidori's startup and settings) shown in a panel or the harness.
 * Installs `chrome`/`browser` synchronously, then links to the hub.
 *
 * Two ways up (DICTIONARY_ENGINES.md §5.2): a child frame posts its hello to its parent's Router;
 * the top document of an engine's hidden extension window (`ext-<id>`, §5.4: the background page,
 * first-party there so its IndexedDB/OPFS persist) has a Router of its own and relays to the
 * overlay's hub over `ext_relay`. That document also creates the offscreen iframe, whose hello
 * then reaches the window's Router like any child frame's.
 */
import { createExtensionContext } from './chrome-api.js'
import { loadMessagesSync } from './i18n.js'
import { connectToParent, connectViaRelay, extensionWindowLabel } from './links.js'
import { createNetworkServer, installDirectNetwork, installFrameNetwork } from './network.js'
import { installWorkerNetwork } from './worker-network.js'
import { probeClaims, storeMarker } from './persistence.js'
import { describe, randomId, within } from './util.js'
import { extCommand } from './primitives.js'

export const BACKGROUND_PAGE = '/__kimochi/ext-background.html'

export function frameKind(win, descriptor) {
  const path = win.location.pathname
  if (path === BACKGROUND_PAGE) return 'background'
  if (descriptor.offscreen && path === `/${descriptor.offscreen}`) return 'offscreen'
  return 'page'
}

export function installFrame(win, { engine, descriptor }) {
  const origin = win.location.origin
  const kind = frameKind(win, descriptor)
  const documentId = randomId()
  const windowLabel = extensionWindowLabel(win, engine)
  let context = null
  let network = null
  let upstream
  let report
  if (windowLabel) {
    // The extension window's own document: Tauri is here, so diagnostics go to native directly
    // (one hop instead of three), and remote fetches go to plugin-http in this window.
    report = (value) => {
      const record = { check: 'ext-host', engine, window: windowLabel, kind, ...value, at: Date.now() }
      console.log('[ext-host]', record)
      void win.__TAURI__.core.invoke(extCommand(win, 'report'), { value: record }).catch(() => {})
    }
    upstream = connectViaRelay(win, {
      engine,
      descriptor,
      origin,
      label: windowLabel,
      kind,
      documentId,
      report,
      // The offscreen iframe's remote requests, performed with this document's direct `fetch`.
      network: createNetworkServer(win, { denied: descriptor.deniedHosts, report, fetch: (url, init) => win.fetch(url, init) }),
      onEvent: (event) => context?.handleEvent(event)
    })
  } else {
    upstream = connectToParent(win, {
      engine,
      kind,
      documentId,
      onEvent: (event) => context?.handleEvent(event),
      onFetchFrame: (frame) => network?.onFrame(frame)
    })
    report = (value) => {
      const record = { engine, window: 'frame', ...value }
      console.log('[ext-host]', record)
      void upstream.call('log', { value: record }).catch(() => {})
    }
  }

  context = createExtensionContext({
    win,
    engine,
    descriptor,
    origin,
    kind,
    link: upstream,
    report,
    // Synchronous: an options page's own script runs right after this one (§5.3 i18n).
    messages: loadMessagesSync(origin, descriptor.manifest, win)
  })
  installGlobals(win, context.chrome)
  if (windowLabel) installDirectNetwork(win, { denied: descriptor.deniedHosts, report })
  else network = installFrameNetwork(win, { upstream, denied: descriptor.deniedHosts, report })
  // Module workers this document starts relay their remote requests through it (worker-network.js;
  // Hachidori's dictionary downloads run in its engine and import workers). The server uses this
  // document's own `fetch`: relayed to the parent in a frame, plugin-http in an extension window.
  installWorkerNetwork(win, {
    origin,
    report,
    server: createNetworkServer(win, { denied: descriptor.deniedHosts, report, fetch: (url, init) => win.fetch(url, init) })
  })

  win.addEventListener('error', (event) =>
    report({ check: 'ext-host-frame-error', error: event.message, file: event.filename, line: event.lineno, stack: String(event.error?.stack ?? '').slice(0, 2000) })
  )
  win.addEventListener('unhandledrejection', (event) =>
    report({ check: 'ext-host-frame-rejection', error: describe(event.reason), stack: String(event.reason?.stack ?? '').slice(0, 2000) })
  )
  win.addEventListener('pagehide', () => context.disconnectAll())
  upstream.linked.catch((error) => console.warn('[ext-host]', describe(error)))

  if (kind === 'offscreen') {
    if (descriptor.engineStorage === 'idbfs') keepEngineOnIdbfs(win)
    // Ready once its module scripts have run and registered their listeners (see hub `offscreen`).
    win.addEventListener('load', () => void upstream.call('ready').catch(() => {}))
  }
  if (kind === 'background') {
    const start = async () => {
      if (windowLabel) {
        // Before any extension script runs here: is chrome.storage describing data that is not
        // in this WebKit store (§5.4.1)? The hub resets stale metadata before anyone reads it.
        await checkPersistence(win, { descriptor, upstream, report })
        // The offscreen document is this window's child, created now and kept for the session
        // (§5.4); the hub waits for it to register over this window's Router.
        if (descriptor.offscreen) createOffscreenFrame(win, { origin, descriptor, report })
      }
      void startBackground(win, { origin, descriptor, context, upstream, report })
    }
    if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', () => void start(), { once: true })
    else void start()
  }

  win.__kimochiExtensionHost = { engine, descriptor, kind, window: windowLabel, ready: upstream.linked, log: report }
  return context
}

/**
 * Keep Hachidori's engine on IDBFS (engines.js `engineStorage`). offscreen.js `selectEngine` takes
 * its threaded IDBFS runtime when `navigator.storage.getDirectory` is missing, so the offscreen
 * document's own StorageManager stops offering it; that check is the only use of it there. The
 * engine workers, the persistence probe and the settings pages keep theirs. Without cross-origin
 * isolation (the custom scheme) offscreen.js has already chosen its single-thread IDBFS engine
 * before it looks, so this changes nothing there.
 */
export function keepEngineOnIdbfs(win) {
  const storage = win.navigator?.storage
  if (typeof storage?.getDirectory !== 'function') return false
  try {
    Object.defineProperty(storage, 'getDirectory', { value: undefined, configurable: true })
    return true
  } catch {
    return false
  }
}

/**
 * §5.4.1: mark this WebKit store, probe what the storage file claims is kept here, and let the hub
 * reconcile. Bounded: a hub that does not answer must not keep the engine from starting.
 */
export async function checkPersistence(win, { descriptor, upstream, report }) {
  if (!descriptor.persistence) return null
  const marker = storeMarker(win, () => randomId('S'))
  try {
    const { claimed } = await within(upstream.call('persistenceClaims'), 15000, 'the hub did not answer the storage check')
    const probe = await probeClaims(win, descriptor.persistence.probe, Array.isArray(claimed) ? claimed : [])
    if (probe.error) report({ check: 'ext-host-storage-probe-failed', error: probe.error, checked: probe.checked })
    return await within(upstream.call('persistenceReport', { store: marker.id, fresh: marker.fresh, ...probe }), 15000, 'the hub did not answer the storage check')
  } catch (error) {
    report({ check: 'ext-host-storage-probe-failed', error: describe(error) })
    return null
  }
}

/** The offscreen document, as a hidden child of the extension window's background page. */
export function createOffscreenFrame(win, { origin, descriptor, report }) {
  const doc = win.document
  if (doc.querySelector?.('iframe[data-kimochi-extension="offscreen"]')) return null
  const frame = doc.createElement('iframe')
  frame.src = `${origin}/${descriptor.offscreen}`
  frame.title = `${descriptor.name} offscreen document`
  frame.hidden = true
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('allow', 'autoplay; clipboard-read; clipboard-write')
  frame.dataset.kimochiExtension = 'offscreen'
  frame.style.cssText = 'display:none !important'
  ;(doc.body ?? doc.documentElement).append(frame)
  report({ check: 'ext-host-offscreen-created', url: frame.src })
  return frame
}

export function installGlobals(win, chrome) {
  try {
    win.chrome = chrome
  } catch {
    Object.defineProperty(win, 'chrome', { value: chrome, configurable: true, writable: true })
  }
  if (win.chrome !== chrome) Object.defineProperty(win, 'chrome', { value: chrome, configurable: true, writable: true })
  // 10ten's webextension-polyfill uses `globalThis.browser` as is when `browser.runtime.id` is
  // set (10ten-ja-content.js, the polyfill's first lines), so it talks to this promise-returning
  // surface directly instead of re-wrapping the callback forms.
  win.browser = chrome
}

/**
 * Load the background script (unless the page already did), then tell the hub it is up and fire
 * `onInstalled` or `onStartup` the way Chrome does after a worker's first evaluation.
 */
async function startBackground(win, { origin, descriptor, context, upstream, report }) {
  // The background script was written for a service worker whose base URL is the extension root.
  // 10ten resolves its database worker relative to it (`new Worker("./10ten-ja-jpdict.js")`, chosen
  // because `"Worker" in self` holds in a window too); from this page, under `/__kimochi/`, that
  // would 404. A <base> restores the root as the base URL. Inserted here, once the document is
  // parsed and before the script loads, not at install: native injects the host at document start,
  // and on WebView2 that runs before `document.documentElement` exists.
  const doc = win.document
  if (!doc.querySelector?.('base[data-kimochi-extension]')) {
    const base = doc.createElement('base')
    base.href = `${origin}/`
    base.dataset.kimochiExtension = 'base'
    ;(doc.head ?? doc.documentElement).prepend(base)
  }
  const src = `${origin}/${descriptor.background.script}`
  const present = [...win.document.scripts].some((s) => s.src === src)
  if (!present) {
    try {
      await new Promise((resolve, reject) => {
        const script = win.document.createElement('script')
        if (descriptor.background.type === 'module') script.type = 'module'
        script.src = src
        script.onload = () => resolve()
        script.onerror = () => reject(Error(`Background script ${descriptor.background.script} failed to load`))
        win.document.head.append(script)
      })
    } catch (error) {
      report({ check: 'ext-host-background-failed', error: describe(error) })
      void upstream.call('failed', { error: describe(error) }).catch(() => {})
      return
    }
  }
  try {
    await upstream.call('ready')
    const install = await upstream.call('install')
    if (install?.event === 'installed') context.events.onInstalled.emit(install.details)
    else if (install?.event === 'startup') context.events.onStartup.emit()
    report({ check: 'ext-host-background-started', lifecycle: install?.event ?? 'none', reason: install?.details?.reason })
  } catch (error) {
    report({ check: 'ext-host-background-failed', error: describe(error) })
  }
}
