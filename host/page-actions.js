/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * What a browser does for an extension's own pages that a Kimochi window does not: links,
 * `window.open`, file downloads and file drops (Yomitan's settings, welcome, info and support
 * pages, its search page and its popups).
 *
 * - **Links.** In Chrome a `target="_blank"` link opens a tab and any other web link navigates
 *   the tab. Here there are no tabs: WKWebView has no new-window handler (a `_blank` link or
 *   `window.open` did nothing), WebView2 opened a bare in-app browser window, and a web link
 *   without a target loaded the website inside the settings frame, with no way back. Web links
 *   now go to the system browser; a page of the extension that asked for a new tab opens in the
 *   dictionary window; `chrome://`, `about:` and the like (Yomitan's "configure shortcuts in the
 *   browser" links) do nothing, as they cannot mean anything here.
 * - **Downloads.** Yomitan saves its settings backup, its dictionary collection export and its
 *   Anki deck export by clicking a detached `<a download href="blob:…">`. WKWebView cancels that
 *   navigation (no download handler) and nothing was saved. The blob is handed to native, which
 *   asks where to save it (`ext_save_file`).
 * - **File drops.** With the window's native drop handler off (so Yomitan's "drop a dictionary
 *   here" zone receives files), a file dropped anywhere else would make the web view open it in
 *   place of the page; outside a drop zone such a drop is refused.
 *
 * The host passes `open(url)` (opens a web link in the system browser and an extension page in
 * the dictionary window) and `save({name, bytes, type})`. Nothing in the extension is modified;
 * this listens at the window, after the page's own handlers, and wraps two prototypes.
 */

const INSTALLED = Symbol.for('kimochi.pageActions.installed')

/** Targets that keep a navigation in the frame that asked for it. */
const SAME_FRAME = new Set(['', '_self', '_parent', '_top'])

/**
 * What following `href` from a page at `base` means here:
 * - `web`: an http(s) page elsewhere, for the system browser;
 * - `page`: a page of the extension itself (same origin);
 * - `ignore`: a browser-internal or foreign scheme (`chrome:`, `about:`, `file:`, `mailto:` …)
 *   that has nothing to open here;
 * - `none`: something the page handles itself (`blob:`, `data:`, `javascript:`, a bare fragment).
 */
export function classifyLink(href, base) {
  if (typeof href !== 'string' || !href.trim()) return { kind: 'none', url: null }
  let url
  let page
  try {
    page = new URL(base)
    url = new URL(href, page)
  } catch {
    return { kind: 'none', url: null }
  }
  if (['blob:', 'data:', 'javascript:'].includes(url.protocol)) return { kind: 'none', url: url.href }
  // Custom schemes (`tauri://localhost`) give an opaque origin in some engines: compare the parts.
  if (url.protocol === page.protocol && url.host === page.host) return { kind: 'page', url: url.href }
  if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'web', url: url.href }
  return { kind: 'ignore', url: url.href }
}

/** The pages this applies to: an extension's own `/name.html` at its origin root, not Kimochi's. */
export function isExtensionPage(win) {
  try {
    return /^\/[\w-]+\.html$/.test(win.location.pathname) && win.location.pathname !== '/index.html'
  } catch {
    return false
  }
}

/** The anchor a click landed on, through shadow roots (Yomitan's popup content is in one). */
function anchorOf(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target]
  for (const node of path) {
    if (node && node.localName === 'a' && typeof node.getAttribute === 'function' && node.getAttribute('href') !== null)
      return node
  }
  return null
}

/** A link whose click is a download of in-page data (Yomitan's `_saveBlob`). */
function isDataDownload(anchor) {
  if (!anchor || typeof anchor.hasAttribute !== 'function' || !anchor.hasAttribute('download')) return false
  return /^(blob|data):/i.test(String(anchor.href ?? ''))
}

/**
 * Links and `window.open` in one extension page.
 *
 * @param {Window} win
 * @param {{open: (url: string, kind: 'web'|'page') => unknown, log?: (value: object) => void}} host
 */
export function installPageLinks(win, { open, log = () => {} }) {
  const done = (win[INSTALLED] ??= {})
  if (done.links) return
  done.links = true
  const base = () => win.location.href

  /** True when the link was taken over (the caller then cancels the default). */
  const follow = (href, target, how) => {
    const { kind, url } = classifyLink(href, base())
    if (kind === 'web') {
      void Promise.resolve()
        .then(() => open(url, 'web'))
        .catch((error) => log({ check: 'page-link-failed', kind, url: url.slice(0, 300), error: String(error?.message ?? error) }))
      return true
    }
    if (kind === 'page') {
      // A link without a target stays in its frame, as in a tab; a new tab means the dictionary window.
      if (SAME_FRAME.has(String(target ?? '').toLowerCase())) return false
      void Promise.resolve()
        .then(() => open(url, 'page'))
        .catch((error) => log({ check: 'page-link-failed', kind, url: url.slice(0, 300), error: String(error?.message ?? error) }))
      return true
    }
    if (kind === 'ignore') {
      log({ check: 'page-link-ignored', how, url: String(url).slice(0, 300) })
      return true
    }
    return false
  }

  const onClick = (event) => {
    // After the page's own handlers (bubble phase at the window): Yomitan's popup turns internal
    // links into searches itself and cancels them, and those are left alone.
    if (event.defaultPrevented) return
    if (event.type === 'click' ? event.button !== 0 : event.button !== 1) return
    const anchor = anchorOf(event)
    if (!anchor || isDataDownload(anchor)) return
    // A modified or middle click asks for a new tab: never a navigation of this frame.
    const target = event.type === 'auxclick' || event.metaKey || event.ctrlKey || event.shiftKey ? '_blank' : anchor.target
    if (follow(anchor.getAttribute('href'), target, event.type)) event.preventDefault()
  }
  win.addEventListener('click', onClick)
  win.addEventListener('auxclick', onClick)

  const nativeOpen = typeof win.open === 'function' ? win.open.bind(win) : null
  win.open = function (url, target, features) {
    if (url !== undefined && url !== null && follow(String(url), target ?? '_blank', 'window.open')) return null
    return nativeOpen ? nativeOpen(url, target, features) : null
  }
}

/**
 * Downloads of in-page data (`<a download href="blob:…">`) in one extension page: clicked by the
 * user, `click()`ed, or sent a synthetic click event on a detached anchor, as Yomitan does.
 *
 * @param {Window} win
 * @param {{save: (file: {name: string, bytes: ArrayBuffer, type: string}) => unknown, log?: (value: object) => void}} host
 */
export function installDownloads(win, { save, log = () => {} }) {
  const done = (win[INSTALLED] ??= {})
  if (done.downloads) return
  done.downloads = true
  const Anchor = win.HTMLAnchorElement
  if (!Anchor?.prototype) return

  const download = (anchor) => {
    const href = String(anchor.href)
    const name =
      anchor.getAttribute('download') || (/^(blob|data):/i.test(href) ? '' : href.split(/[/?#]/).filter(Boolean).at(-1)) || 'download'
    void (async () => {
      try {
        // Read at once: Yomitan revokes the URL a minute later.
        const blob = await (await win.fetch(href)).blob()
        await save({ name, bytes: await blob.arrayBuffer(), type: blob.type })
      } catch (error) {
        log({ check: 'page-download-failed', name: String(name).slice(0, 200), error: String(error?.message ?? error) })
      }
    })()
  }

  const proto = Anchor.prototype
  const nativeClick = proto.click
  proto.click = function () {
    if (isDataDownload(this)) return download(this)
    return nativeClick.call(this)
  }
  const nativeDispatch = proto.dispatchEvent ?? win.EventTarget?.prototype.dispatchEvent
  proto.dispatchEvent = function (event) {
    // A detached anchor's synthetic click never reaches a window listener; it is caught here.
    if (event?.type === 'click' && !this.isConnected && isDataDownload(this)) {
      download(this)
      return false
    }
    return nativeDispatch.call(this, event)
  }
  win.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    const anchor = anchorOf(event)
    if (!isDataDownload(anchor)) return
    event.preventDefault()
    download(anchor)
  })
}

/**
 * Refuse file drops nothing on the page accepted, so a stray drop cannot make the web view open
 * the file in place of the page. A drop zone that accepts files cancels `dragover` itself.
 *
 * @param {Window} win
 */
export function installFileDropGuard(win) {
  const done = (win[INSTALLED] ??= {})
  if (done.drops) return
  done.drops = true
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files')
  win.addEventListener('dragover', (event) => {
    if (event.defaultPrevented || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'none'
  })
  win.addEventListener('drop', (event) => {
    if (!event.defaultPrevented && hasFiles(event)) event.preventDefault()
  })
}
