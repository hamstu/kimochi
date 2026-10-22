/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * The generic browser-extension host (DICTIONARY_ENGINES.md §5), bundled by scripts/prepare.mjs
 * into `dist/spike/ext-host.js` as a classic IIFE: native injects it at document start into every
 * frame of the extension-hosting windows, and host pages load it with a plain `<script src>`. It
 * must therefore install `chrome`/`browser` synchronously, before the extension's own scripts.
 *
 * Coexists with the Yomitan shims (host/yomitan/, bundled as dist/spike/shim.js and panel-shim.js), which native injects into
 * the same windows: each resolves the engine the same way, and exactly one of them installs.
 * This one only ever touches `chrome`, `browser` and `__kimochiExtensionHost`.
 */
import { installApp } from './app.js'
import { ENGINES } from './engines.js'
import { installFrame } from './frame.js'
import { engineForExtensionOrigin, extensionOrigin, resolveEngine } from './util.js'

;(() => {
  const win = window
  if (win.__kimochiExtensionHost || win.__kimochiExtHostInstalling) return
  win.__kimochiExtHostInstalling = true
  try {
    install(win)
  } catch (error) {
    // Clear the flag so a later copy (a host page's own <script src="/__kimochi/ext-host.js">)
    // can try again once the document exists; native's document-start copy can run before
    // `document.documentElement` does (WebView2).
    win.__kimochiExtHostInstalling = false
    console.error('[ext-host] install failed', error)
  }
})()

function install(win) {
  // An extension-origin document cannot read the app origin's localStorage mirror, so its engine
  // comes from its own origin (and native's prelude, which names it for such frames). A child frame
  // that is cross-origin to its top document is treated as a candidate extension document too:
  // that is how the browser harness's loopback per-port origins are recognised (by their manifest).
  const { origin, protocol, hostname } = win.location
  const named = Object.keys(ENGINES).some(
    (id) => extensionOrigin(id, win) === origin || protocol === `${id}:` || hostname === `${id}.localhost`
  )
  let crossOriginChild = false
  // A child of an engine's extension window (the offscreen document, §5.4) is same-origin with
  // its top document, whose host says which window it is. Native's prelude names such a frame
  // anyway; the browser harness's loopback extension window has no prelude in its children.
  let inExtensionWindow = false
  if (win !== win.top) {
    try {
      crossOriginChild = win.top.location.origin !== origin
      inExtensionWindow = !crossOriginChild && Boolean(win.top.__kimochiExtensionHost?.window)
    } catch {
      crossOriginChild = true
    }
  }
  // Only loopback origins are probed that way: a third-party frame never gets a request from us.
  const loopback = /^https?:$/.test(protocol) && /^(127\.0\.0\.1|localhost)$/.test(hostname)
  if (named || inExtensionWindow || (crossOriginChild && loopback)) {
    const engine = engineForExtensionOrigin(win)
    if (engine) installFrame(win, { engine, descriptor: ENGINES[engine] })
    return
  }
  const engineHere = resolveEngine(win)
  const appEngine = ENGINES[engineHere] ? engineHere : null
  // App documents: only the top document of a window, and only for the two extension engines
  // ('yomitan' and 'builtin' are the Yomitan shims' to serve; 'custom-api' and 'none' need nothing).
  if (!appEngine) return
  if (win !== win.top) return
  if (!['tauri:', 'http:', 'https:'].includes(win.location.protocol)) return
  installApp(win, { engine: appEngine, descriptor: ENGINES[appEngine] })
}
