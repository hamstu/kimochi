/**
 * Yomitan in the browser harness (DICTIONARY_ENGINES.md §11.5): the overlay's Yomitan path
 * (`ui/overlay.js` `startYomitan`) run in Chrome at the app origin, over the real
 * `dist/spike/shim.js` bundle that `ui/dictionary-harness.html` loads at document start.
 *
 * Native injects that shim into every frame of the overlay; here the dev server does it for the
 * frames the harness creates (the backend page, Yomitan's popup, its settings page), keyed on a
 * cookie the harness sets (`kimochi-harness-shim=yomitan`, see vite.dev.config.ts).
 *
 * Returns the same small API the generic host gives the harness (`start`, `observePopup`,
 * `lookupRange`, `popupControl`, `dismiss`, `openOptionsPage`, `status`), so the buttons and a
 * devtools-driven test drive all three engines the same way.
 */

const FIXTURE_TITLE = 'Tauri Spike Fixture v2'
const READY_TIMEOUT_MS = 30000

/**
 * `dictionaries`: Yomitan zip URLs to import in place of the fixture (`?dictionary=` on the page,
 * as the dictionary preview capture passes its JMdict excerpt). Each is imported once: a title
 * already in the database comes back from Yomitan as "already imported" and is kept.
 */
export function createYomitanHarness({ log, openPage, dictionaries = [] }) {
  const hub = window.__extensionHost
  const state = { ready: false, error: null, dictionaries: [], fixture: null }
  // The page's own fetch, taken before /spike/network-bundle.js routes remote URLs to plugin-http
  // (which the harness only stands in for with ?fetch=proxy): the dictionary URLs are the
  // harness's own inputs, not the engine's network.
  const pageFetch = window.fetch.bind(window)
  let popups = new Set()
  const watchers = new Set()

  const api = async (action, params) => {
    const response = await chrome.runtime.sendMessage({ action, params })
    if (response?.error) throw Error(JSON.stringify(response.error))
    return response?.result
  }

  /** The visible popup chain's union rectangle, from Yomitan's public `Popup` API. */
  const popupRect = () => {
    let rect = null
    for (const popup of popups) {
      if (!popup.isVisibleSync?.()) continue
      const r = popup.getFrameRect()
      if (!r?.valid) continue
      rect = rect
        ? { left: Math.min(rect.left, r.left), top: Math.min(rect.top, r.top), right: Math.max(rect.right, r.right), bottom: Math.max(rect.bottom, r.bottom) }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    }
    return rect && { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
  }
  let last = null
  const changed = () => {
    const rect = popupRect()
    const same = (a, b) => (a === null && b === null) || (a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
    if (same(rect, last)) return
    last = rect
    for (const watcher of watchers) watcher({ visible: rect !== null, rect })
  }
  const visiblePopup = () => [...popups].reverse().find((popup) => popup.isVisibleSync?.()) ?? null

  /** Imports one Yomitan zip and enables it in the current profile; its title, and whether it was new. */
  async function importDictionary(url) {
    const { DictionaryWorker } = await import('/js/dictionary/dictionary-worker.js')
    const imported = await new DictionaryWorker().importDictionary(
      await pageFetch(url).then((r) => {
        if (!r.ok) throw Error(`${url}: HTTP ${r.status}`)
        return r.arrayBuffer()
      }),
      { prefixWildcardsSupported: false },
      null
    )
    const duplicate = imported.errors.length === 1 && /is already imported/.test(String(imported.errors[0]?.message ?? imported.errors[0]))
    if (imported.errors.length && !duplicate) throw Error(JSON.stringify(imported.errors))
    const title = imported.result?.title ?? /Dictionary (.*) is already imported/.exec(String(imported.errors[0]?.message ?? imported.errors[0]))?.[1]
    const options = await api('optionsGetFull')
    const profile = options.profiles[options.profileCurrent].options
    if (title && !profile.dictionaries.some((d) => d.name === title)) {
      profile.dictionaries.push({
        name: title,
        alias: '',
        partsOfSpeechFilter: true,
        useDeinflections: true,
        enabled: true,
        allowSecondarySearches: false,
        definitionsCollapsible: 'not-collapsible'
      })
      await api('setAllSettings', { value: options, source: 'kimochi-harness' })
      await api('triggerDatabaseUpdated', { type: 'dictionary', cause: 'import' })
    }
    return { title, imported: !duplicate }
  }

  async function importFixture() {
    const existing = await api('getDictionaryInfo')
    if (existing.some((d) => d.title === FIXTURE_TITLE)) return { alreadyInstalled: true }
    const { title } = await importDictionary('/spike/fixture.zip')
    return { imported: title ?? FIXTURE_TITLE }
  }

  /** `startYomitan`, step for step, minus the native-only parts (relay, setup jobs). */
  async function startBackend() {
    if (!hub) throw Error('dist/spike/shim.js did not install (window.__extensionHost is missing)')
    // Extension pages open in the harness's own frame, as `openInIframe` does in the overlay.
    hub.open = (url) => {
      openPage(new URL(url, location.href).href)
      return { id: 1, windowId: 1, url }
    }
    await import('/spike/network-bundle.js')
    hub.manifest = await fetch('/manifest.json').then((r) => r.json())
    hub.local = await window.__TAURI__.core.invoke('storage_load')
    if (!hub.local.options) {
      const { OptionsUtil } = await import('/js/data/options-util.js')
      const util = new OptionsUtil()
      await util.prepare()
      const options = util.getDefault()
      options.profiles[0].options.general.showGuide = false
      await util.save(options)
    }
    const ready = new Promise((resolve, reject) => {
      const listener = (message) => {
        if (message.action !== 'applicationBackendReady') return
        chrome.runtime.onMessage.removeListener(listener)
        resolve()
      }
      chrome.runtime.onMessage.addListener(listener)
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener)
        reject(Error(`Dictionary backend did not signal readiness within ${READY_TIMEOUT_MS / 1000}s`))
      }, READY_TIMEOUT_MS)
    })
    const backend = document.createElement('iframe')
    backend.id = 'backend'
    backend.hidden = true
    backend.src = '/spike/background.html'
    document.body.append(backend)
    await ready
    // Before the frontend exists, so no popup can be built without being seen.
    const { observePopups } = await import('/spike/popup-bridge.js')
    ;({ popups } = await observePopups({ log, window: 'harness', onChange: changed }))
    // installApiLookup imports frontend-mode.js, which must wrap Frontend#prepare before the
    // frontend is created (scan scope, setTextSource); the Yomitan API pop-up path itself stays off.
    const { installApiLookup } = await import('/ui/api-lookup.js')
    await installApiLookup()
    if (dictionaries.length > 0) {
      state.fixture = null
      state.imported = []
      for (const url of dictionaries) state.imported.push(await importDictionary(url))
    } else state.fixture = await importFixture()
    await import('/js/app/content-script-wrapper.js')
    state.dictionaries = (await api('getDictionaryInfo')).map((d) => d.title)
    state.ready = true
    log({ check: 'yomitan-ready', dictionaries: state.dictionaries, fixture: state.fixture })
  }

  let starting = null
  return {
    engine: 'yomitan',
    api,
    start({ scope = null } = {}) {
      starting ??= (async () => {
        try {
          await startBackend()
          if (scope) (await import('/spike/frontend-mode.js')).setScanScope(scope)
          return { ready: true }
        } catch (error) {
          state.error = String(error?.message ?? error)
          log({ check: 'yomitan-start-failed', error: state.error, stack: String(error?.stack ?? '') })
          return { ready: false, error: state.error }
        }
      })()
      return starting
    },
    observePopup(callback) {
      watchers.add(callback)
      return () => watchers.delete(callback)
    },
    isPopupVisible: () => popupRect() !== null,
    /** What the visible popup shows, for a test to assert on (its frame is same-origin). */
    popupText: () => visiblePopup()?._frame?.contentDocument?.getElementById('dictionary-entries')?.innerText ?? null,
    /** As the overlay's controller path: `frontend-mode.js` `lookupRange` (`Frontend#setTextSource`). */
    async lookupRange(range) {
      const { lookupRange } = await import('/spike/frontend-mode.js')
      return lookupRange(range)
    },
    /**
     * As the overlay's `controlPopup`: Yomitan's popup is a same-origin frame, scrolled directly;
     * a step sends the popup Yomitan's default `nextEntry` / `previousEntry` hotkey (Alt+↓ / Alt+↑).
     */
    popupControl({ scroll, step } = {}) {
      const popup = visiblePopup()
      const doc = popup?._frame?.contentDocument ?? null
      const scroller = doc?.getElementById('content-scroll')
      if (!scroller) return { popup: Boolean(popup), scroller: false }
      if (scroll) scroller.scrollTop += scroll
      if (step) {
        const win = popup._frame.contentWindow
        const key = step > 0 ? 'ArrowDown' : 'ArrowUp'
        win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key, code: key, altKey: true, bubbles: true, cancelable: true }))
      }
      return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight }
    },
    /** As the overlay's `dismissPopup`: Yomitan closes on a pointerdown outside its frame. */
    dismiss() {
      window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true }))
    },
    openOptionsPage() {
      openPage(new URL('/settings.html', location.href).href)
    },
    status: () => ({ ...state, contexts: hub ? hub.contexts.size : 0, popups: popups.size })
  }
}
