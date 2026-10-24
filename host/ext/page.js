/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * What a browser tab gives an extension page and a webview frame does not: links that leave the
 * page, `window.open`, and downloads. Installed in extension pages (`kind: 'page'`: Hachidori's
 * settings and startup pages, 10ten's options) shown in Kimochi's `dictionary` window.
 *
 * - **Links out.** In Chrome a link to the web (`target=_blank` or not) opens a browser tab. In
 *   the settings frame it would either do nothing (WKWebView and WebKitGTK refuse new windows
 *   nobody handles), open a bare WebView2 window (Windows), or load the site inside the settings
 *   window. Any http(s) link to another origin goes to the system browser instead, through the
 *   hub's `open` (hub.js, the same path as `tabs.create`).
 * - **Pages of the extension in a new tab** (`target=_blank` to its own origin, `window.open`) go
 *   through the same `open`, which shows them in the `dictionary` window. A plain same-origin link
 *   still navigates the frame, as it would the tab.
 * - **Downloads.** `<a download href="blob:…">` (Hachidori's backup, debug info and Anki add-on)
 *   has no download UI to go to in a webview: WKWebView cancels it, WebKitGTK drops it, WebView2
 *   saves it unannounced. The host reads the bytes and asks its window to save them, which shows
 *   a save dialog (`ext_save_file`, src-tauri/src/extensions.rs).
 * - **Browser-internal links** (`chrome://extensions/shortcuts` and the like) have nowhere to go;
 *   they are stopped and reported rather than loading an error page into the frame.
 *
 * A page's own click handler runs first: anything it has already handled (`preventDefault`, as
 * 10ten does for `chrome://` links before its `tabs.create`) is left to it.
 */

const SAME_TAB = new Set(['', '_self', '_parent', '_top'])

/**
 * What following `anchor` should do here: `null` (let the browser do it), or
 * `{action: 'open' | 'download' | 'refuse', url, name?}`.
 */
export function linkAction(anchor, { origin, newTab = false }) {
  const href = anchor?.getAttribute?.('href')
  if (href === null || href === undefined || href === '') return null
  let url
  try {
    url = new URL(anchor.href ?? href)
  } catch {
    return null
  }
  if (url.protocol === 'javascript:') return null
  if (anchor.hasAttribute?.('download')) {
    if (url.protocol === 'blob:' || url.protocol === 'data:' || sameOrigin(url, origin)) {
      return { action: 'download', url: url.href, name: anchor.getAttribute('download') || fileName(url) }
    }
  }
  const target = String(anchor.getAttribute?.('target') ?? anchor.target ?? '').toLowerCase()
  const elsewhere = newTab || !SAME_TAB.has(target)
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!sameOrigin(url, origin)) return { action: 'open', url: url.href }
    return elsewhere ? { action: 'open', url: url.href } : null
  }
  // A link into the page itself (`#section`) and the extension's own scheme behave as in a tab.
  if (sameOrigin(url, origin)) return elsewhere ? { action: 'open', url: url.href } : null
  if (url.protocol === 'blob:' || url.protocol === 'data:' || url.protocol === 'about:') return null
  // mailto:, chrome://, edge://, file: and the rest: nothing in a webview frame can follow them.
  return { action: 'refuse', url: url.href }
}

/** The URL `window.open(url)` should hand to the hub, or null to let the platform have it. */
export function windowOpenTarget(rawUrl, { base, origin }) {
  if (rawUrl === undefined || rawUrl === null || String(rawUrl) === '') return null
  let url
  try {
    url = new URL(String(rawUrl), base)
  } catch {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:' || sameOrigin(url, origin)) return url.href
  return null
}

function sameOrigin(url, origin) {
  // `new URL('hachidori://localhost/x').origin` is "null"; compare protocol and host instead.
  try {
    const expected = new URL(`${origin}/`)
    return url.protocol === expected.protocol && url.host === expected.host
  } catch {
    return false
  }
}

function fileName(url) {
  if (url.protocol === 'blob:' || url.protocol === 'data:') return 'download'
  const last = url.pathname.split('/').filter(Boolean).at(-1)
  try {
    return decodeURIComponent(last ?? '') || 'download'
  } catch {
    return last || 'download'
  }
}

/**
 * Install the link, `window.open` and download handling in an extension page. `open(url)` asks
 * the hub to open a URL (`tabs.create`'s path), `save(name, bytes)` asks this frame's window to
 * save a file; both return promises.
 */
export function installPage(win, { origin, open, save, report }) {
  const doc = win.document
  const follow = (decision) => {
    if (decision.action === 'open') {
      Promise.resolve(open(decision.url)).catch((error) =>
        report({ check: 'ext-host-link-failed', url: decision.url.slice(0, 300), error: String(error?.message ?? error) })
      )
      return
    }
    if (decision.action === 'download') {
      void download(win, decision, save, report)
      return
    }
    report({ check: 'ext-host-link-refused', url: decision.url.slice(0, 300) })
  }

  // Bubble phase on the window, after the page's own handlers have had their say.
  const onClick = (event) => {
    if (event.defaultPrevented) return
    if (event.type === 'click' && event.button !== 0) return
    if (event.type === 'auxclick' && event.button !== 1) return
    const anchor = anchorOf(event)
    if (!anchor) return
    const newTab = event.type === 'auxclick' || event.metaKey || event.ctrlKey || event.shiftKey
    const decision = linkAction(anchor, { origin, newTab })
    if (!decision) return
    event.preventDefault()
    follow(decision)
  }
  win.addEventListener('click', onClick)
  win.addEventListener('auxclick', onClick)

  // `anchor.click()` on an anchor that is not in the document (Hachidori's blob-download.js) is
  // never seen by a listener on the window: its click event has no ancestors to bubble through.
  const Anchor = win.HTMLAnchorElement
  const nativeClick = Anchor?.prototype?.click
  if (typeof nativeClick === 'function') {
    Anchor.prototype.click = function click() {
      if (!this.isConnected) {
        const decision = linkAction(this, { origin })
        if (decision) {
          // Its own listeners still run, as they would; only the default action is ours.
          const event = new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win })
          if (this.dispatchEvent(event)) follow(decision)
          return
        }
      }
      return nativeClick.call(this)
    }
  }

  const nativeOpen = win.open
  if (typeof nativeOpen === 'function') {
    win.open = function open(url, target, features) {
      const wanted = windowOpenTarget(url, { base: doc?.baseURI ?? win.location.href, origin })
      if (!wanted) return nativeOpen.call(win, url, target, features)
      follow({ action: 'open', url: wanted })
      // Chrome hands back a WindowProxy; `noopener` callers get null there too.
      return null
    }
  }
}

function anchorOf(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target]
  for (const node of path) {
    if (node?.localName === 'a' || node?.localName === 'area') return node.hasAttribute?.('href') ? node : null
  }
  return null
}

async function download(win, { url, name }, save, report) {
  try {
    const response = await win.fetch(url)
    if (!response.ok) throw Error(`HTTP ${response.status}`)
    const bytes = await response.arrayBuffer()
    // Read before the save: the buffer is transferred to the window, which detaches it here.
    const size = bytes.byteLength
    const result = await save(name, bytes)
    report({ check: 'ext-host-download', name, bytes: size, saved: Boolean(result?.saved) })
  } catch (error) {
    report({ check: 'ext-host-download-failed', name, error: String(error?.message ?? error) })
  }
}
