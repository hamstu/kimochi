/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Engine descriptors (DICTIONARY_ENGINES.md §5.1).
 *
 * The content-script lists, the background script and the manifest itself are read from the
 * committed copy of the release's manifest, `extensions/<id>.manifest.json`, at build time:
 * esbuild inlines the JSON, so the host never hand-maintains a list that can drift from the
 * release it serves, and `getManifest()` answers synchronously (both extensions call it at module
 * load). The copy is the release's own bytes: sync-extension.test.mjs checks it against
 * `extensions/<id>.sha256.json`, and the app checks the downloaded tree against the same map, so
 * the host is never built against a manifest that differs from the one it serves
 * (EXTENSION_DOWNLOADS.md §1, "The manifest problem", Option A).
 */
import hachidoriManifest from '../../extensions/hachidori.manifest.json'
import tentenManifest from '../../extensions/tenten.manifest.json'

export const ENGINES = {
  hachidori: {
    id: 'hachidori',
    name: 'Hachidori',
    manifest: hachidoriManifest,
    optionsPage: hachidoriManifest.options_page,
    background: { type: 'module', script: hachidoriManifest.background.service_worker },
    // Kept alive by the host for the session (§5.4). background-core.js `relay()` sends every
    // dictionary request to it, and `ensureChromeOffscreen` only creates one when getContexts
    // finds none, so a document that is already up is simply adopted.
    offscreen: 'offscreen.html',
    contentScripts: hachidoriManifest.content_scripts[0].js,
    contentCss: hachidoriManifest.content_scripts[0].css ?? [],
    // content.js `HOST_TAG`: a zero-sized fixed anchor whose open shadow root holds one
    // `.gsm-hoshidicts-popup` per popup level, hidden with the `hidden` attribute.
    popupSelector: 'hachidori-host',
    popupParts: '.gsm-hoshidicts-popup:not([hidden])',
    // The pointer events its scanner listens for, in the order to dispatch them: content.js
    // `document.addEventListener("mousemove", onMouseMove, …)` (≈ line 4288) and nothing else, so a
    // synthetic pointer feed (the overlay's native pointer, lookupRange's fallback) must send
    // `mousemove`; a `pointermove` alone is never seen.
    pointerEvents: ['mousemove'],
    // How it marks the text a lookup matched: a CSS custom highlight, content.js `HIGHLIGHT_NAME`
    // (painted by `HDPopup.createSourceHighlighter`). Its selection is no guide: lookupRange makes
    // one itself.
    matchHighlights: ['gsm-hoshidicts-match'],
    matchSelection: false,
    storageSeed: {},
    // §5.4.1: what chrome.storage says is kept in the origin's own storage, and how to check it.
    // dictionaryState lists each imported dictionary with its directory in the engine's IDBFS
    // mount (`/dicts/.hdw-generation-<uuid>/<title>`, engine-service.js `DICT_ROOT`); the
    // single-thread engine Kimochi runs (engine-worker-local.js) persists that mount in the
    // IndexedDB database `/dicts`, store `FILE_DATA`, one record per path. OPFS is checked too,
    // for the WasmFS/OPFS engine.
    persistence: {
      metadataKeys: ['dictionaryState'],
      claimed: (local) =>
        (local?.dictionaryState?.dictionaries ?? []).map((d) => d?.path).filter((p) => typeof p === 'string' && p.startsWith('/dicts/')),
      probe: { kind: 'idbfs-paths', database: '/dicts', store: 'FILE_DATA', opfs: true }
    },
    // Where its engine keeps dictionaries: always that IDBFS store (frame.js `keepEngineOnIdbfs`).
    // On its cross-origin-isolated loopback origin (src-tauri/src/loopback.rs) offscreen.js would
    // otherwise move to its OPFS engine where the webview offers it (WebView2), which cannot see
    // the dictionaries the single-thread engine imported into IDBFS and that the one-time copy
    // brought over. Its threaded IDBFS engine reads and writes the same store and still imports on
    // several threads.
    engineStorage: 'idbfs',
    deniedHosts: [],
    // Absent (§5.3): background.js `createTimerAlarms()` takes over when `chrome.alarms` is
    // missing, which is the path its overlay hosts (GSM) already run.
    alarms: false
  },
  tenten: {
    id: 'tenten',
    name: '10ten Japanese Reader',
    manifest: tentenManifest,
    optionsPage: tentenManifest.options_ui.page,
    background: { type: 'classic', script: tentenManifest.background.service_worker },
    offscreen: null,
    contentScripts: tentenManifest.content_scripts[0].js,
    contentCss: [],
    // popup/popup-container.ts: `#tenten-ja-window` with an open shadow root; the popup is
    // `.container` (hidden by the `hidden` class) holding `.window` and the arrow.
    popupSelector: '#tenten-ja-window',
    popupParts: '.container:not(.hidden) .window, .container:not(.hidden) .arrow',
    // content.ts `window.addEventListener('pointermove', this.onPointerMove, …)`; its mousemove
    // listener only serves Safari's duplicate-event workaround and the hold-to-show keys.
    pointerEvents: ['pointermove'],
    // How it marks the text a lookup matched (content/text-highlighter.ts `highlightRegularNode`):
    // a CSS custom highlight, by highlight style, or a DOM selection where the Highlight API
    // cannot be used.
    matchHighlights: ['tenten-selection', 'tenten-selection-blue'],
    matchSelection: true,
    // tab-manager.ts `#getStoredEnabledState`: 10ten stays off until its toolbar button is
    // pressed, and Kimochi has no toolbar. Seeded once, on the first load of the storage file.
    storageSeed: { local: { enabled: true } },
    // Look-ups wait for Shift, as they do with Yomitan and Hachidori, instead of opening on bare
    // hover (10ten's own default). Its "Show popup" keys (options page), stored by
    // config.ts as `holdToShowKeys` ("Shift", "Alt+Ctrl"…; absent means hover). Once per
    // storage file, new or old, and only where no key is set: one the reader chose is kept,
    // and so is hover if they switch back to it afterwards.
    storageMigrations: [
      {
        id: 'tenten-hold-shift',
        apply: (store) => {
          if (typeof store.sync.holdToShowKeys !== 'string' || !store.sync.holdToShowKeys) {
            store.sync.holdToShowKeys = 'Shift'
          }
        }
      }
    ],
    // §5.4.1: `lastDbUpdateTime` (jpdict-state.ts) says the jpdict IndexedDB was downloaded; it
    // is stale when that database is empty or absent in this store.
    persistence: {
      metadataKeys: ['lastDbUpdateTime'],
      claimed: (local) => (local?.lastDbUpdateTime === undefined || local?.lastDbUpdateTime === null ? [] : ['jpdict']),
      probe: { kind: 'indexeddb-nonempty', database: 'jpdict', store: 'words' }
    },
    // Bugsnag error reporting (@birchill/bugsnag-zero) posts to these from the background and
    // the options page; a desktop app does not phone home on the user's behalf.
    deniedHosts: ['notify.bugsnag.com', 'sessions.bugsnag.com'],
    alarms: true
  }
}

export const ENGINE_IDS = Object.keys(ENGINES)
