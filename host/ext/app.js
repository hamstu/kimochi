/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * An app-origin top document: the overlay (the hub, whose background and offscreen documents run in
 * the engine's hidden extension window and relay to it), the Log (a relay client running content
 * scripts over its transcript), the dictionary panel and the welcome window (relay clients for
 * their extension iframes), or the browser harness (a hub). Publishes
 * `window.__kimochiExtensionHost` — the API ui/overlay.js and the Log code against.
 */
import { scanOf } from './capture.js'
import { createExtensionContext } from './chrome-api.js'
import { createDriver, injectContentScripts, installScope, observePopup as watchPopup } from './content.js'
import { Hub } from './hub.js'
import { loadMessages } from './i18n.js'
import { Router, connectRelay, localUpstream, serveRelay } from './links.js'
import { createNetworkServer, guardPageFetch } from './network.js'
import { installGlobals } from './frame.js'
import { describe, extensionOrigin, originOf, randomId, sleep, tabIdFor, within } from './util.js'
import { watchReadiness } from './readiness.js'

const START_TIMEOUT_MS = 120000
/** Windows whose own document runs content scripts and therefore gets `chrome` at document start. */
const CONTENT_WINDOWS = new Set(['overlay', 'log'])

export function installApp(win, { engine, descriptor }) {
  const label = win.__kimochiPanelLabel || (win.location.pathname === '/ui/overlay.html' ? 'overlay' : undefined)
  const origin = extensionOrigin(engine, win)
  const tauri = win.__TAURI__
  const invoke = (command, args) => {
    if (!tauri?.core?.invoke) return Promise.reject(Error(`Native command ${command} is unavailable here`))
    return tauri.core.invoke(command, args)
  }
  const reportLabel = label ?? 'harness'
  const report = (value) => {
    const record = { check: 'ext-host', engine, window: reportLabel, ...value, at: Date.now() }
    console.log('[ext-host]', record)
    win.dispatchEvent(new win.CustomEvent('kimochi-ext-host-report', { detail: record }))
    void invoke('report', { value: record }).catch(() => {})
  }

  const network = createNetworkServer(win, { denied: descriptor.deniedHosts, report })
  const router = new Router({ win, engine, descriptor, origin, label: label ?? 'overlay', report, network })
  router.acceptChildren()

  const api = {
    engine,
    descriptor,
    label: label ?? null,
    tabId: tabIdFor(label ?? 'overlay'),
    pendingNavigate: null,
    ready: null,
    log: (value) => report(typeof value === 'object' && value !== null ? value : { message: String(value) })
  }
  let resolveReady
  api.ready = new Promise((resolve) => (resolveReady = resolve))
  void router.upstreamReady.then(() => resolveReady())

  let lastNavigateAt = 0
  const navigate = (url) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (originOf(parsed.href) !== origin) {
      report({ check: 'ext-host-navigate-refused', url: String(url).slice(0, 300) })
      return
    }
    // The same page can arrive twice: relayed, and picked up by this window's hello when it was
    // not yet listening for the relay (the hub keeps the last one for a minute). Once is enough.
    if (api.pendingNavigate === parsed.href && Date.now() - lastNavigateAt < 3000) return
    lastNavigateAt = Date.now()
    api.pendingNavigate = parsed.href
    win.dispatchEvent(new win.CustomEvent('kimochi-dictionary-navigate', { detail: { url: parsed.href } }))
  }

  // Relay client: every Kimochi window other than the overlay (and the harness, which is a hub).
  let relay = null
  let requestedEnabled = true
  let lookupReady = false
  const scopeState = { enabled: false, scope: null, lastTarget: null }
  const applyReadiness = (status) => {
    lookupReady = status?.phase === 'ready'
    scopeState.enabled = requestedEnabled && lookupReady
    if (!scopeState.enabled && driver?.visible()) void driver.dismiss()
  }
  const isHubWindow = label === 'overlay' || label === undefined
  if (!isHubWindow && label !== 'popup-host' && tauri?.event?.listen) {
    relay = connectRelay(router, { tauri, label, engine, report, onNavigate: navigate, onSetup: applyReadiness })
  }

  // `chrome` exists from document start where content scripts will run; other windows only relay.
  let context = null
  let contentLink = null
  if (CONTENT_WINDOWS.has(label) || label === undefined) {
    const link = {
      call: async (op, args) => {
        if (!contentLink) throw Error('The extension host has not been started in this window')
        return contentLink.call(op, args)
      }
    }
    // The transcript line last scanned (the Log's scope), whose OCR frame a capture should show.
    const captureHint = () => {
      const scan = scanOf(scopeState.lastTarget)
      return scan ? { scan } : null
    }
    context = createExtensionContext({ win, engine, descriptor, origin, kind: 'content', link, report, captureHint })
    installGlobals(win, context.chrome)
    guardPageFetch(win, { denied: descriptor.deniedHosts, report })
  }

  // ---------------------------------------------------------------- hub (overlay, harness)

  let hub = null
  let relayServer = null
  /** Set after a failed start, so the next one asks native for a fresh extension window. */
  let reloadWindow = false
  let stopReadiness = null
  const publishReadiness = (status) => {
    if (hub) hub.setup = status
    applyReadiness(status)
    report({ check: 'dictionary-readiness', ...status })
    void relayServer?.broadcast({ type: 'setup', setup: status })
  }
  if (isHubWindow) report({ check: 'dictionary-readiness', phase: 'starting', message: `Starting ${descriptor.name}…` })

  /**
   * The engine's background and offscreen documents live in its hidden extension window
   * (`ext-<id>`, DICTIONARY_ENGINES.md §5.4), the top document there, so their storage is
   * first-party and outlives a quit. Native creates it at startup and on a switch; asking again
   * here is idempotent, and covers a hub that came up first.
   */
  async function ensureExtensionWindow() {
    const reload = reloadWindow
    let answer
    try {
      answer = await invoke('extension_window_ensure', { engine, reload })
    } catch (error) {
      throw Error(`The ${descriptor.name} background window could not be opened: ${describe(error)}`)
    }
    report({ check: 'ext-host-window', action: answer?.action ?? null, label: answer?.label ?? `ext-${engine}`, reload })
  }

  async function startHub() {
    hub = new Hub({ engine, origin, label: 'overlay', invoke, report, openLocally: navigate, win })
    hub.setup = { phase: 'starting', message: `Starting ${descriptor.name}…` }
    await hub.loadStorage()
    router.setUpstream(localUpstream(hub, router))
    relayServer = await serveRelay(hub, { tauri, label: 'overlay', engine, report })
    // Windows already waiting (the extension window, the Log) say hello at once.
    void relayServer.broadcast({ type: 'serving', hub: hub.instance })
    try {
      await ensureExtensionWindow()
      const failed = () => hub.failure
      const up = (kind) => () => {
        if (failed()) throw Error(failed())
        return hub.readyContext(kind)
      }
      await hub.until(up('background'), START_TIMEOUT_MS, `The ${descriptor.name} background did not start within ${START_TIMEOUT_MS / 1000}s`)
      if (descriptor.offscreen) {
        await hub.until(up('offscreen'), START_TIMEOUT_MS, `The ${descriptor.name} offscreen document did not load within ${START_TIMEOUT_MS / 1000}s`)
      }
    } catch (error) {
      hub.engineError = describe(error)
      publishReadiness({ phase: 'failed', message: `${descriptor.name} could not start. Open its settings or choose the engine again to retry.` })
      report({ check: 'ext-host-ready', ready: false, error: hub.engineError, ...hub.status() })
      throw error
    }
    hub.engineReady = true
    hub.engineError = null
    void relayServer.broadcast({ type: 'ready', hub: hub.instance })
    report({ check: 'ext-host-ready', ready: true, ...hub.status() })
    await ensureContentLink()
    stopReadiness?.()
    stopReadiness = watchReadiness({ win, engine, chrome: context.chrome, publish: publishReadiness,
      subscribe: (observe) => { hub.observeMessage = observe } })
  }

  // ---------------------------------------------------------------- client (Log)

  async function startClient() {
    if (!relay) throw Error(`No relay to the overlay from the ${reportLabel} window`)
    const deadline = Date.now() + START_TIMEOUT_MS
    let last = 'The overlay did not answer'
    while (Date.now() < deadline) {
      try {
        const reply = await relay.probe(Math.max(1, Math.min(1500, deadline - Date.now())))
        if (reply.ready) return
        last = reply.error ?? `The overlay's ${descriptor.name} host is still starting`
      } catch (error) {
        last = describe(error)
      }
      await sleep(250)
    }
    throw Error(`${descriptor.name} is unavailable in the ${reportLabel} window: ${last}`)
  }

  // ---------------------------------------------------------------- content scripts here

  let driver = null
  let contentRunning = false

  async function ensureContentLink() {
    if (!context || contentLink) return
    contentLink = router.attach(
      { kind: 'content', url: win.location.href, documentId: randomId(), top: true },
      (event) => context.handleEvent(event)
    )
    await contentLink.registered
  }

  async function startContent(scope) {
    if (!context) return
    scopeState.scope = scope ?? null
    await ensureContentLink()
    context.setMessages(await loadMessages(origin, descriptor.manifest, win))
    if (driver) return
    installScope(win, { origin, popupSelector: descriptor.popupSelector, state: scopeState })
    driver = createDriver(win, {
      descriptor,
      context,
      report,
      backgroundSender: () => ({ id: context.runtimeId, url: `${origin}/${descriptor.background.script}`, origin })
    })
    if (win.document.readyState === 'loading') {
      await new Promise((resolve) => win.document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    }
    await injectContentScripts(win, { origin, descriptor, report })
    contentRunning = true
    win.addEventListener('error', (event) => {
      if (String(event.filename ?? '').startsWith(origin)) {
        report({ check: 'ext-host-content-error', error: event.message, file: event.filename, line: event.lineno })
      }
    })
    win.addEventListener('unhandledrejection', (event) => {
      if (String(event.reason?.stack ?? '').includes(origin)) {
        report({ check: 'ext-host-content-rejection', error: describe(event.reason) })
      }
    })
    win.addEventListener('pagehide', () => {
      context.disconnectAll()
      contentLink?.detach()
    })
  }

  // ---------------------------------------------------------------- the API

  let starting = null
  let hubStarted = null
  const ensureHub = () => {
    hubStarted ??= within(startHub(), START_TIMEOUT_MS + 5000, `The ${descriptor.name} host did not start`).catch((error) => {
      // Nothing of a failed hub survives, so a retry starts clean, in a fresh extension window.
      hubStarted = null
      hub = null
      reloadWindow = true
      throw error
    })
    return hubStarted
  }
  api.start = (options = {}) => {
    starting ??= (async () => {
      const host = options.host ?? label === 'overlay'
      try {
        if (label === 'popup-host') throw Error('The popup-host window does not run an extension engine')
        if (host) await ensureHub()
        else await startClient()
        await startContent(options.scope)
        report({ check: 'ext-host-started', host: Boolean(host), scope: options.scope ?? null, content: contentRunning })
        return { ready: true }
      } catch (error) {
        const message = describe(error)
        report({ check: 'ext-host-start-failed', error: message })
        starting = null
        return { ready: false, error: message }
      }
    })()
    return starting
  }
  api.setEnabled = (enabled) => {
    requestedEnabled = Boolean(enabled)
    scopeState.enabled = requestedEnabled && lookupReady
    if (!scopeState.enabled && driver?.visible()) void driver.dismiss()
  }
  api.observePopup = (callback) => watchPopup(win, descriptor, callback)
  api.isPopupVisible = () => Boolean(driver?.visible())
  api.lookupRange = async (range) => {
    if (!contentRunning || !driver) return false
    // The same gate a pointer lookup meets. 10ten's lookup is a pointer move, so the scope
    // wrappers already refuse it; Hachidori's is a selection plus `scanTextAtSelection`, which
    // never hit-tests, and would otherwise look up text outside the scope or while disabled.
    if (!scopeState.enabled) return false
    if (scopeState.scope) {
      const start = range?.startContainer
      const element = start?.nodeType === 1 ? start : start?.parentElement
      const line = element?.closest?.(scopeState.scope)
      if (!line) return false
      scopeState.lastTarget = line
    }
    try {
      return await driver.lookupRange(range)
    } catch (error) {
      report({ check: 'ext-host-lookup-failed', error: describe(error) })
      return false
    }
  }
  api.matchedRange = () => driver?.matched() ?? null
  api.popupControl = (control) => driver?.popupControl(control ?? {})
  api.dismiss = () => void driver?.dismiss()
  api.openOptionsPage = () => {
    const url = `${origin}/${descriptor.optionsPage}`
    // Same as `chrome.runtime.openOptionsPage`; from a window without a context of its own the
    // router asks the hub directly.
    void router.upstreamReady
      .then((upstream) => upstream.call('open', { url }))
      .catch((error) => report({ check: 'ext-host-open-failed', error: describe(error) }))
  }
  api.clickAction = () => hub?.clickAction()
  api.status = () => (hub ? hub.status() : { ...relay?.status, hub: relay?.status.hub ?? null })

  win.__kimochiExtensionHost = api
  return api
}
