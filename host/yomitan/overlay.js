/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * The Yomitan host of the overlay window, bundled by scripts/prepare.mjs into
 * `dist/spike/shim.js` and injected by native as a document-start script for every frame of the
 * overlay (DICTIONARY_ENGINES.md §3, §11).
 *
 * The overlay owns the single Yomitan backend: `/spike/background.html` runs the unmodified
 * `/sw.js` in a same-origin iframe, and the overlay's frontend, Yomitan's popup frames and that
 * backend find each other through `window.top.__extensionHost`, calling each other's listeners
 * directly. Other windows reach this backend through `ui/overlay.js` `handleRelay`; they run
 * `panel.js` instead, never a second backend on the same IndexedDB.
 */
import { clone, runListeners, selectStorage, storageChanges } from '../ext/primitives.js'
import {
  apiForms,
  assetUrl,
  createChrome,
  dropOnPagehide,
  event,
  installAudioValidity,
  installChrome,
  installLinuxDictionaryImages,
  installLinuxScanInput,
  removeServiceWorker,
  RUNTIME_ID,
  stubSharedWorkerBridge,
  yomitanRoot
} from './common.js'

const BACKGROUND_PAGE = '/spike/background.html'
const MESSAGE_TIMEOUT_MS = 30000

install(window)

function install(win) {
  if (win.__yomitanShim) return
  const root = yomitanRoot(win)
  if (!root) return
  win.__yomitanShim = true

  if (win === root) root.__extensionHost = createHub(root)
  const hub = root.__extensionHost
  if (!hub) return

  const events = { onMessage: event(), onConnect: event(), onChanged: event() }
  const ctx = hub.register(win, events)
  hub.installNetwork?.(win)
  const { api, unsupported } = apiForms((name) => {
    hub.log({ unsupported: name })
    return `${name} is not implemented in this spike`
  })

  function storage(area) {
    const mutate = (fn) =>
      (hub.writes = hub.writes
        .catch(() => {})
        .then(async () => {
          const previous = clone(hub[area])
          fn(hub[area])
          try {
            if (area === 'local') await root.__TAURI__.core.invoke('storage_save', { value: hub.local })
          } catch (e) {
            hub[area] = previous
            throw e
          }
          const changes = storageChanges(previous, hub[area], clone)
          for (const c of hub.contexts.values()) c.events.onChanged.emit(clone(changes), area)
        }))
    return {
      get: api(async (keys) => {
        await hub.writes
        return selectStorage(hub[area], keys, clone)
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

  installChrome(
    win,
    createChrome({
      win,
      root,
      hub,
      ctx,
      events,
      tabId: 1,
      api,
      unsupported,
      storage,
      // The backend talks to every other context; everyone else talks to the backend.
      sendMessage: (message) =>
        hub.message(
          ctx,
          [...hub.contexts.values()].filter((c) => c !== ctx && (ctx.background || c.background)),
          message
        ),
      tabsSendMessage: (id, message, options = {}) => hub.message(ctx, hub.select(id, options.frameId), message)
    })
  )

  removeServiceWorker(win)
  stubSharedWorkerBridge(win, ({ data, ports }, channel) => {
    if (data.action === 'registerBackendPort') hub.bridgePort = channel.port2
    else if (data.action === 'connectToBackend1') {
      if (!hub.bridgePort) throw Error('Background bridge is not ready')
      hub.bridgePort.postMessage(null, [ports[0]])
      channel.port2.close()
    }
  })

  // Dictionary audio the way an extension gets it: see /spike/audio-bridge.js.
  if (ctx.background)
    void import(assetUrl(root, '/spike/audio-bridge.js'))
      .then((m) =>
        m.installBackendFetch(
          (command, args) => root.__TAURI__.core.invoke(command, args),
          (value) => hub.log(value)
        )
      )
      .catch((error) => hub.log({ check: 'audio-bridge-failed', error: String(error?.message ?? error) }))
  installAudioValidity(win, root, (value) => hub.log(value))

  dropOnPagehide(win, hub, ctx)
  win.addEventListener('error', (e) =>
    hub.log({ error: e.message, file: e.filename, line: e.lineno, stack: e.error?.stack, frame: ctx.id })
  )
  win.addEventListener('unhandledrejection', (e) =>
    hub.log({ error: String(e.reason), stack: e.reason?.stack, frame: ctx.id })
  )
  installLinuxDictionaryImages(win, root, (value) => hub.log(value), { frame: ctx.id })
  if (win.__KIMOCHI_PLATFORM__?.os === 'linux' && win !== root) {
    installLinuxScanInput(win, root, (value) => hub.log(value), { passive: true }, { frame: ctx.id })
  }
}

/** The overlay's context table, storage and message routing, on its top window. */
function createHub(root) {
  let nextId = 0
  return {
    contexts: new Map(),
    local: {},
    session: {},
    writes: Promise.resolve(),
    manifest: null,
    bridgePort: null,
    register(win, events) {
      const id = nextId++
      const context = { id, win, events, ports: new Set(), background: win.location.pathname === BACKGROUND_PAGE }
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
        id: RUNTIME_ID,
        url: from.win.location.href,
        origin: from.win.location.origin,
        frameId: from.id,
        tab: { id: 1, windowId: 1, url: root.location.href }
      }
      const { handled, response } = runListeners(targets, message, sender, clone)
      if (!handled) return undefined
      return await Promise.race([
        response,
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(Error(`Message timed out: ${message.action}`)), MESSAGE_TIMEOUT_MS)
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
      if (parsed.origin !== root.location.origin) throw Error('External navigation is not implemented in this spike')
      root.document.querySelector('#extension-page').src = parsed.href
      return { id: 1, windowId: 1, url: parsed.href }
    }
  }
}
