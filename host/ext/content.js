/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * The engine's content scripts in an app document (DICTIONARY_ENGINES.md §5.5): injection, the
 * scan scope, the popup's rectangle, and driving a lookup without a mouse.
 */

import { createPopupFocus, HACHIDORI_FOCUS } from '../../ui/popup-focus.js'

/** `contentCss` as links and `contentScripts` as classic scripts, in manifest order, one at a time. */
export async function injectContentScripts(win, { origin, descriptor, report }) {
  const doc = win.document
  for (const file of descriptor.contentCss) {
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = `${origin}/${file}`
    link.dataset.kimochiExtension = descriptor.id
    doc.head.append(link)
  }
  for (const file of descriptor.contentScripts) {
    await new Promise((resolve, reject) => {
      const script = doc.createElement('script')
      script.src = `${origin}/${file}`
      script.async = false
      script.dataset.kimochiExtension = descriptor.id
      script.onload = () => resolve()
      script.onerror = () => reject(Error(`Content script ${file} failed to load from ${origin}`))
      ;(doc.head ?? doc.documentElement).append(script)
    })
  }
  report({ check: 'ext-host-content-injected', scripts: descriptor.contentScripts.length })
}

/**
 * Confine the extension's scanner to `scope` without touching its code. Both extensions find the
 * text under the pointer with these four calls (Hachidori content-scan.js `caretRangeAt`, its
 * content.js `elementFromPoint`; 10ten get-text.ts), so a point outside the scope, and outside the
 * extension's own popup, answers "nothing here".
 *
 * Only the extension's calls are filtered. The same functions serve Kimochi's own UI in these
 * windows (the Log is React, and its libraries hit-test with `elementFromPoint`), so the caller is
 * told apart by its stack: content scripts are loaded from the extension origin, which appears in
 * the stack of every call they make. A stack the engine will not give is treated as theirs.
 */
export function installScope(win, { origin, popupSelector, state }) {
  const doc = win.document
  const proto = win.Document.prototype
  const native = {
    caretRangeFromPoint: proto.caretRangeFromPoint ?? doc.caretRangeFromPoint,
    caretPositionFromPoint: proto.caretPositionFromPoint ?? doc.caretPositionFromPoint,
    elementFromPoint: proto.elementFromPoint ?? doc.elementFromPoint,
    elementsFromPoint: proto.elementsFromPoint ?? doc.elementsFromPoint
  }
  const fromExtension = () => {
    const stack = new Error().stack
    return !stack || stack.includes(origin)
  }
  const allowed = (x, y) => {
    if (!state.enabled) return false
    if (!state.scope) return true
    const element = native.elementFromPoint.call(doc, x, y)
    if (!element) return false
    const inScope = element.closest?.(state.scope)
    // The line being read, for a mining screenshot of the frame it came from (capture.js).
    if (inScope) state.lastTarget = inScope
    return Boolean(inScope || element.closest?.(popupSelector))
  }
  const wrap = (name, empty) => {
    const original = native[name]
    if (typeof original !== 'function') return
    doc[name] = function (x, y, ...rest) {
      if (fromExtension() && !allowed(x, y)) return empty()
      return original.call(this === undefined ? doc : this, x, y, ...rest)
    }
  }
  wrap('caretRangeFromPoint', () => null)
  wrap('caretPositionFromPoint', () => null)
  wrap('elementFromPoint', () => null)
  wrap('elementsFromPoint', () => [])
  return { native }
}

/** The popup's union rectangle in this document's CSS pixels, or null when nothing is shown. */
export function popupRect(win, descriptor) {
  const host = win.document.querySelector(descriptor.popupSelector)
  if (!host) return null
  const root = host.shadowRoot ?? host
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const element of root.querySelectorAll(descriptor.popupParts)) {
    const style = win.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }
  if (left === Infinity) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Watch the popup: a MutationObserver on the document (the host element is created lazily) and
 * on its open shadow root (popups move by restyling and hide by attribute or class), plus a
 * ResizeObserver on the shown parts. Changes are coalesced to one report per frame.
 */
export function observePopup(win, descriptor, callback) {
  const doc = win.document
  let last = null
  let scheduled = false
  let observedRoot = null
  let stopped = false
  const observedParts = new Set()
  const resize = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => schedule()) : null
  const inner = new win.MutationObserver(() => schedule())
  const sameRect = (a, b) => (a === null && b === null) || (a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
  const measure = () => {
    scheduled = false
    if (stopped) return
    const host = doc.querySelector(descriptor.popupSelector)
    const root = host?.shadowRoot ?? host ?? null
    if (root !== observedRoot) {
      inner.disconnect()
      observedRoot = root
      if (root) inner.observe(root, { subtree: true, childList: true, attributes: true })
    }
    if (resize && root) {
      // Observing an element delivers an initial resize notification, even if
      // its size has not changed. Re-observing every measurement loops forever.
      const parts = new Set(root.querySelectorAll(descriptor.popupParts))
      for (const element of observedParts) {
        if (!parts.has(element)) {
          resize.unobserve(element)
          observedParts.delete(element)
        }
      }
      for (const element of parts) {
        if (!observedParts.has(element)) {
          observedParts.add(element)
          resize.observe(element)
        }
      }
    } else if (resize && observedParts.size) {
      resize.disconnect()
      observedParts.clear()
    }
    const rect = popupRect(win, descriptor)
    if (sameRect(rect, last)) return
    last = rect
    try {
      callback({ visible: rect !== null, rect })
    } catch (error) {
      console.error(error)
    }
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    ;(win.requestAnimationFrame ?? ((f) => setTimeout(f, 16)))(measure)
  }
  const outer = new win.MutationObserver(() => schedule())
  outer.observe(doc.documentElement, { childList: true, subtree: true })
  win.addEventListener('scroll', schedule, true)
  win.addEventListener('resize', schedule)
  schedule()
  return () => {
    stopped = true
    outer.disconnect()
    inner.disconnect()
    resize?.disconnect()
    win.removeEventListener('scroll', schedule, true)
    win.removeEventListener('resize', schedule)
  }
}

/**
 * The stylesheet that puts an engine's top-level pop-up exactly over `rect` (CSS pixels of this
 * document), for Read along's full-screen dictionary: it goes in the pop-up host's open shadow
 * root, and its `!important` rules outrank the inline position and size the engine writes on
 * every show. '' for no rect or an engine without one.
 *
 *  - Hachidori: its root level, `.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]`, positioned
 *    from its zero-sized fixed host with inline `left`/`top`/`width`/`height` (content.js
 *    `placePopup`). Its nested levels keep their own placing, beside the word they look up.
 *  - 10ten: `.container` at `--tenten-left`/`--tenten-top`, its `.window` sized by content up to
 *    `--tenten-max-width` (600px) and `--tenten-max-height` (popup/show-popup.ts). The window is
 *    held at the box's width, and between its height as a minimum and a maximum, so a short entry
 *    still fills the box and a long one scrolls inside it; the arrow at the word is hidden.
 */
export function fillCss(engine, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return ''
  const px = (value) => `${Math.round(value * 100) / 100}px`
  const [x, y, width, height] = [px(rect.x), px(rect.y), px(rect.width), px(rect.height)]
  if (engine === 'hachidori') {
    return `.gsm-hoshidicts-popup[data-hoshidicts-depth="0"] {
  left: ${x} !important; top: ${y} !important;
  width: ${width} !important; height: ${height} !important;
  min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important;
}`
  }
  if (engine === 'tenten') {
    return `.container {
  left: ${x} !important; top: ${y} !important;
  padding: 0 !important; max-height: none !important;
  -webkit-mask-image: none !important; mask-image: none !important;
}
.container .window {
  box-sizing: border-box !important;
  width: ${width} !important; max-width: ${width} !important;
  min-height: ${height} !important; max-height: ${height} !important;
}
.container .arrow { display: none !important; }`
  }
  return ''
}

/** Hachidori's in-page command channel (content.js `onReaderCommand`). */
const readerCommand = (action) => ({ target: 'hachidori-reader', type: 'hd_reader_command', action })

const firstRect = (range) => {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
  return rects[0] ?? range.getBoundingClientRect()
}

/**
 * Where to point for a range: the centre of its first character. Both scanners look up the text
 * *starting* at the hit point, so the centre of the whole range (§5.5 as first written) looked up
 * the word's tail: for 食べました, 10ten answered ました.
 */
function lookupPoint(range) {
  const node = range.startContainer
  if (node?.nodeType === 3 && typeof range.cloneRange === 'function' && range.startOffset < node.length) {
    const first = range.cloneRange()
    first.setEnd(node, Math.min(node.length, range.startOffset + 1))
    const rect = firstRect(first)
    if (rect.width > 0 && rect.height > 0) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }
  const rect = firstRect(range)
  return { x: rect.left + Math.min(rect.width / 2, rect.height / 2), y: rect.top + rect.height / 2 }
}

function scroller(win, descriptor) {
  const host = win.document.querySelector(descriptor.popupSelector)
  const root = host?.shadowRoot ?? host
  if (!root) return null
  let best = null
  for (const part of root.querySelectorAll(descriptor.popupParts)) {
    for (const element of [part, ...part.querySelectorAll('*')]) {
      if (element.scrollHeight <= element.clientHeight + 1) continue
      const overflow = win.getComputedStyle(element).overflowY
      if (overflow !== 'auto' && overflow !== 'scroll') continue
      // The deepest popup level is the last part; within it, the largest scroller.
      if (!best || part !== best.part || element.clientHeight > best.element.clientHeight) best = { part, element }
    }
  }
  return best?.element ?? null
}

/** The deepest open popup level: the last visible part (`descriptor.popupParts`). */
function popupLevel(win, descriptor) {
  const host = win.document.querySelector(descriptor.popupSelector)
  const root = host?.shadowRoot ?? host
  if (!root) return null
  const parts = [...root.querySelectorAll(descriptor.popupParts)]
  return parts[parts.length - 1] ?? null
}

/**
 * 10ten's dictionary tabs (popup/tabs.ts: `.tab-bar .tabs > li.tab`, the selected one
 * `aria-selected`, each a button that switches to its dictionary): the one `step` tabs from the
 * selected one, wrapping, clicked. Its `nextDictionary` keys only go forwards. False without tabs.
 */
function stepTenTenTab(win, descriptor, step) {
  const host = win.document.querySelector(descriptor.popupSelector)
  const tabs = [...(host?.shadowRoot?.querySelectorAll('.tab-bar .tabs > .tab') ?? [])].filter(
    (tab) => !tab.classList.contains('disabled') && tab.querySelector('button, a')
  )
  if (tabs.length < 2) return false
  const selected = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')
  const next = tabs[(Math.max(0, selected) + step + tabs.length) % tabs.length]
  next.querySelector('button, a').click()
  return true
}

function keydown(win, key, code) {
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }))
  win.dispatchEvent(new win.KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true }))
}

/**
 * A synthetic pointer move at (x, y) as the engine listens for it (`descriptor.pointerEvents`):
 * `pointermove` as a mouse PointerEvent, `mousemove` as a MouseEvent. `expando` is copied onto
 * each event (10ten's `fromPuck`).
 */
export function dispatchPointer(win, descriptor, target, x, y, expando = {}) {
  for (const type of descriptor.pointerEvents) {
    const init = { clientX: x, clientY: y, buttons: 0, bubbles: true, cancelable: true, composed: true }
    const event = type.startsWith('pointer') && typeof win.PointerEvent === 'function'
      ? new win.PointerEvent(type, { ...init, pointerType: 'mouse' })
      : new win.MouseEvent(type, init)
    Object.assign(event, expando)
    target.dispatchEvent(event)
  }
}

/**
 * Run `fn` with `element` and its ancestors that are at opacity 0 made all but invisible
 * instead (0.001), then put them back. 10ten finds the text to look up as the pointer event
 * arrives and drops it when `checkVisibility({checkOpacity: true})` says it is not shown
 * (10ten-ja-content.js `isVisible`), and the overlay holds its text at opacity 0 while the
 * controller reads, drawing its own outline instead. Only for the event: Yomitan's scanner
 * relies on opacity 0 to end a lookup at a box's edge, so it is never left changed.
 */
export function withTextShown(win, element, fn) {
  const changed = []
  for (let at = element; at && at.nodeType === 1; at = at.parentElement) {
    if (win.getComputedStyle(at).opacity !== '0') continue
    changed.push([at, at.style.getPropertyValue('opacity'), at.style.getPropertyPriority('opacity')])
    at.style.setProperty('opacity', '0.001', 'important')
  }
  try {
    return fn()
  } finally {
    for (const [at, value, priority] of changed.reverse()) {
      if (value) at.style.setProperty('opacity', value, priority)
      else at.style.removeProperty('opacity')
    }
  }
}

/** A press and release away from the popup, which both extensions read as "dismiss". */
function clickAway(win, descriptor) {
  const rect = popupRect(win, descriptor)
  const w = win.innerWidth || 1
  const h = win.innerHeight || 1
  const corners = [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2]]
  const [x, y] = corners.find(([cx, cy]) => !rect || cx < rect.x || cx > rect.x + rect.width || cy < rect.y || cy > rect.y + rect.height) ?? corners[0]
  const target = win.document.documentElement
  for (const type of ['mousedown', 'mouseup']) {
    target.dispatchEvent(new win.MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0, bubbles: true, cancelable: true, composed: true }))
  }
}

export function createDriver(win, { descriptor, context, report, backgroundSender }) {
  const engine = descriptor.id
  const command = (action) => context.deliverLocal(readerCommand(action), backgroundSender())
  const visible = () => popupRect(win, descriptor) !== null
  // The controller's focus on the popup's buttons: Hachidori's; 10ten's popup has none to press.
  const focus =
    engine === 'hachidori'
      ? createPopupFocus({
          root: () => (visible() ? popupLevel(win, descriptor) : null),
          spec: HACHIDORI_FOCUS,
          scroller: () => scroller(win, descriptor)
        })
      : null
  // The selection a Hachidori lookup left behind (see `dismiss`).
  let ownSelection = null
  const sameRange = (a, b) =>
    a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset

  /**
   * Where the top-level pop-up must go (`place`), as {@link fillCss} in the host's shadow root.
   * The host is made on the first lookup and 10ten may make it again, so while a rectangle is set
   * a MutationObserver puts the stylesheet back the moment a host appears: the observer runs
   * before the next paint, so the pop-up is never drawn in its own place first.
   */
  let fill = null
  let fillWatch = null
  let fillClear = 0
  const FILL_ATTRIBUTE = 'data-kimochi-fill'
  function applyFill() {
    const host = win.document.querySelector(descriptor.popupSelector)
    const root = host?.shadowRoot
    if (!root) return
    let style = root.querySelector(`style[${FILL_ATTRIBUTE}]`)
    const css = fillCss(engine, fill)
    if (!css) return void style?.remove()
    if (!style) {
      style = win.document.createElement('style')
      style.setAttribute(FILL_ATTRIBUTE, '')
      root.append(style)
    }
    if (style.textContent !== css) style.textContent = css
  }
  function watchFill(on) {
    if (on && !fillWatch && typeof win.MutationObserver === 'function') {
      fillWatch = new win.MutationObserver(() => applyFill())
      fillWatch.observe(win.document.documentElement, { childList: true, subtree: true })
    } else if (!on && fillWatch) {
      fillWatch.disconnect()
      fillWatch = null
    }
  }

  const waitForPopup = (ms) =>
    new Promise((resolve) => {
      const started = Date.now()
      const tick = () => {
        if (visible()) return resolve(true)
        if (Date.now() - started >= ms) return resolve(false)
        setTimeout(tick, 50)
      }
      tick()
    })

  /**
   * `scanTextAtSelection`, re-sent after a scroll. Any scroll in the document while the lookup is
   * in flight cancels it (content.js `onScroll` → `cancelCandidateScan`, a capture listener, so an
   * element scrolling counts: the Log's transcript following a new line, the harness's log pane),
   * which would otherwise leave the popup to the 1.5 s fallback below.
   */
  async function scanSelection() {
    let scrolled = false
    const onScroll = () => (scrolled = true)
    win.addEventListener('scroll', onScroll, true)
    try {
      await command('scanTextAtSelection')
      const started = Date.now()
      let retries = 3
      while (Date.now() - started < 1500) {
        if (visible()) return true
        if (scrolled && retries > 0) {
          scrolled = false
          retries -= 1
          await command('scanTextAtSelection')
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return visible()
    } finally {
      win.removeEventListener('scroll', onScroll, true)
    }
  }

  return {
    visible,
    /**
     * Put the top-level pop-up over `rect` (this document's CSS pixels) from now on, or with null
     * give it back to the engine's own placing. That waits until the pop-up it filled has closed
     * (up to a second), so a dismissal does not jump it to the word on its way out.
     */
    place(rect) {
      const clear = ++fillClear
      if (rect) {
        fill = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        watchFill(true)
        applyFill()
        return
      }
      if (!fill) return
      const started = Date.now()
      const release = () => {
        if (clear !== fillClear) return
        if (visible() && Date.now() - started < 1000) return void setTimeout(release, 50)
        fill = null
        watchFill(false)
        applyFill()
      }
      release()
    },
    /** Whether the controller can focus the popup's buttons (Hachidori's; 10ten has none). */
    focusable: Boolean(focus),
    /**
     * The text the open popup's lookup matched, as the engine marks it on the page
     * (`descriptor.matchHighlights`, else the selection when `matchSelection`): the start of its
     * first range and the end of its last. Null while nothing is marked.
     */
    matched() {
      if (!visible()) return null
      for (const name of descriptor.matchHighlights ?? []) {
        const ranges = [...(win.CSS?.highlights?.get(name) ?? [])]
        if (!ranges.length) continue
        const first = ranges[0]
        const last = ranges[ranges.length - 1]
        return {
          startContainer: first.startContainer,
          startOffset: first.startOffset,
          endContainer: last.endContainer,
          endOffset: last.endOffset
        }
      }
      if (!descriptor.matchSelection) return null
      const selection = win.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
      const range = selection.getRangeAt(0)
      return {
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset
      }
    },
    /**
     * Hachidori: select the range and send `scanTextAtSelection` (content.js `runKeybindAction`:
     * it needs a single non-collapsed selection and `hoverEnabled`); if no popup follows, the
     * reader's own `scanSelectedText` (exposed through `HDReaderReady`), then a synthetic
     * `mousemove`. 10ten: a `pointermove` carrying `fromPuck`, which is how its puck asks for a
     * lookup (content.ts `onInterFrameMessage`): it skips the hold-to-show keys and the
     * "moving too fast" filter (`isEnRouteToPopup`).
     */
    async lookupRange(range) {
      const { x, y } = lookupPoint(range)
      if (engine === 'hachidori') {
        const selection = win.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        ownSelection = typeof range.cloneRange === 'function' ? range.cloneRange() : range
        if (await scanSelection()) return true
        try {
          const reader = await Promise.race([win.HDReaderReady, new Promise((resolve) => setTimeout(resolve, 500))])
          if (reader?.scanSelectedText?.() && (await waitForPopup(1500))) return true
        } catch {
          // Fall through to the pointer.
        }
        const target = win.document.elementFromPoint(x, y) ?? win.document.body
        dispatchPointer(win, descriptor, target, x, y)
        report({ check: 'ext-host-lookup-fallback', engine, via: descriptor.pointerEvents.join('+') })
        return true
      }
      const start = range.startContainer
      const target = (start.nodeType === 1 ? start : start.parentElement) ?? win.document.body
      withTextShown(win, target, () => dispatchPointer(win, descriptor, target, x, y, { fromPuck: true }))
      return true
    },
    /**
     * The controller in the popup: `scroll` points, `step` entries (10ten: dictionary tabs), and
     * `focus`, its buttons (see ui/popup-focus.js): 'enter', 'exit', 'refocus', a direction,
     * 'press' or 'audio'. Returns whether a `focus` request did anything.
     */
    popupControl({ scroll, step, focus: request } = {}) {
      if (typeof scroll === 'number' && scroll !== 0) {
        const element = scroller(win, descriptor)
        if (element) element.scrollBy({ top: scroll, behavior: 'auto' })
        else report({ check: 'ext-host-popup-control', engine, missing: 'scroller' })
      }
      if (step === 1 || step === -1) {
        if (engine === 'hachidori') void command(step === 1 ? 'nextEntry' : 'previousEntry')
        // 10ten has no entry cursor; its step is the next or previous dictionary tab (words →
        // kanji → names). Without tabs, the `nextDictionary` keys (default Shift / Enter;
        // content.ts `handleKey`), which only go forwards.
        else if (!stepTenTenTab(win, descriptor, step)) keydown(win, 'Enter', 'Enter')
      }
      if (!request) return false
      if (!focus) return false
      if (request === 'enter') return focus.enter()
      if (request === 'exit') return (focus.exit(), true)
      if (request === 'refocus') return focus.refocus()
      if (request === 'press') return focus.press()
      if (request === 'audio') return focus.playAudio()
      if (request === 'available') return focus.available()
      return focus.move(request)
    },
    async dismiss() {
      if (engine === 'hachidori') {
        await command('close')
        // The selection lookupRange made outlives the popup, and Hachidori keeps treating it as
        // the live lookup: content.js `retainSelectedLookup` (called from `scanActivatedPointer`)
        // makes the next Shift+hover re-show the selected word instead of the one under the
        // pointer, and `onSelectionChange` looks it up again on the next selection event. Drop it
        // once the popup is closed (clearing it while the popup shows would close the popup,
        // `onSelectionChange` → `hide()`), and only if it is still the one this driver made.
        const selection = win.getSelection()
        if (ownSelection && selection?.rangeCount === 1 && sameRange(selection.getRangeAt(0), ownSelection)) selection.removeAllRanges()
        ownSelection = null
      } else keydown(win, 'Escape', 'Escape')
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (visible()) clickAway(win, descriptor)
    }
  }
}
