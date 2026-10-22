/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Pressing a dictionary pop-up's own buttons from the controller: Add to Anki, Play audio and the
 * rest, without touching the engine's code.
 *
 * The pop-up's buttons are found in its DOM (Yomitan's popup frame, Hachidori's shadow root, each
 * described by an engine's `FocusSpec`), one of them carries the focus ring, the D-pad moves it to
 * the nearest button that way on screen, and A clicks it, exactly as the mouse would. The ring is
 * an attribute plus a stylesheet added to the pop-up's own root, so it is drawn inside the pop-up
 * whatever its theme and goes away with its entries when a new lookup replaces them.
 *
 * @typedef {object} FocusSpec
 * @property {string|null} entries the pop-up's entries, in order; null when an entry's buttons
 *   are not inside it (Hachidori pins the shown entry's buttons in a header), and then the
 *   topmost button on screen stands for the current entry's
 * @property {string} controls the buttons the controller may focus
 * @property {string} preferred the button to start on (Add to Anki)
 * @property {string} audio the play-audio button
 * @property {string} [current] the entry the engine marks as current, if it does
 */

export const FOCUS_ATTRIBUTE = 'data-kimochi-focus'
const STYLE_ID = 'kimochi-popup-focus'
/** The controller's accent (controller.css `--cm-accent`), drawn the way its word outline is. */
const STYLE = `[${FOCUS_ATTRIBUTE}] {
  outline: 2px solid #7dd3fc !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 5px rgba(125, 211, 252, 0.28), 0 0 18px rgba(125, 211, 252, 0.55) !important;
  border-radius: 6px;
  position: relative;
  z-index: 1;
  transition: outline-offset 0.12s ease;
}
[${FOCUS_ATTRIBUTE}="pressed"] { outline-offset: 0 !important; }
@media (prefers-reduced-motion: reduce) { [${FOCUS_ATTRIBUTE}] { transition: none; } }`

/** The rectangle of an element, or null when it is not laid out (hidden, or not in the page). */
function rectOf(element) {
  const rect = element.getBoundingClientRect?.()
  if (!rect || rect.width <= 0 || rect.height <= 0) return null
  return rect
}

const centre = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })

/**
 * The candidate nearest `from` in direction `dir`, or -1. Ahead means its centre is past `from`'s
 * centre that way; the distance across counts twice as much as the distance along, so a button in
 * the same row (left/right) or column (up/down) wins over a closer one off to the side.
 *
 * @param {{left: number, top: number, width: number, height: number}} from
 * @param {{left: number, top: number, width: number, height: number}[]} rects
 * @param {'up'|'down'|'left'|'right'} dir
 */
export function nearestInDirection(from, rects, dir) {
  const a = centre(from)
  const horizontal = dir === 'left' || dir === 'right'
  const sign = dir === 'right' || dir === 'down' ? 1 : -1
  let best = -1
  let bestScore = Infinity
  rects.forEach((rect, index) => {
    if (!rect) return
    const b = centre(rect)
    const along = (horizontal ? b.x - a.x : b.y - a.y) * sign
    const across = Math.abs(horizontal ? b.y - a.y : b.x - a.x)
    // Past the middle of `from`, so buttons side by side in a row are not "below" each other.
    const reach = (horizontal ? from.width : from.height) / 4
    if (along <= reach) return
    const score = along + across * 2
    if (score < bestScore) {
      bestScore = score
      best = index
    }
  })
  return best
}

/**
 * @param {object} options
 * @param {() => (Document|ShadowRoot|Element|null)} options.root the open pop-up's content, or null
 * @param {FocusSpec} options.spec
 * @param {() => (Element|null)} [options.scroller] the pop-up's scrolling element, for "the entry in view"
 */
export function createPopupFocus({ root, spec, scroller = () => null }) {
  let focused = null

  const styleHost = (node) => {
    if (!node) return null
    if (node.nodeType === 9) return node.head ?? node.documentElement // a Document
    if (node.nodeType === 11) return node // a ShadowRoot
    return node.getRootNode?.() ?? null
  }

  function ensureStyle(node) {
    const host = styleHost(node)
    if (!host) return
    const doc = host.ownerDocument ?? host
    const present = host.querySelector?.(`#${STYLE_ID}`)
    if (present) return
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE
    host.append(style)
  }

  function entries(node) {
    if (!spec.entries) return []
    return [...node.querySelectorAll(spec.entries)].filter((entry) => rectOf(entry))
  }

  /** The visible matches of `selector` in `scope`, topmost first. */
  function visible(scope, selector) {
    return [...scope.querySelectorAll(selector)]
      .filter((control) => !control.hidden && !control.disabled && rectOf(control))
      .sort((a, b) => rectOf(a).top - rectOf(b).top)
  }

  function controlsIn(scope) {
    return visible(scope, spec.controls)
  }

  /** The entry the reader is on: the engine's current one, else the first one in view. */
  function currentEntry(node) {
    const list = entries(node)
    if (!list.length) return null
    if (spec.current) {
      const marked = list.find((entry) => entry.matches(spec.current))
      if (marked) return marked
    }
    const view = scroller()?.getBoundingClientRect?.()
    if (!view) return list[0]
    return list.find((entry) => entry.getBoundingClientRect().bottom > view.top + 12) ?? list[0]
  }

  function setFocus(control) {
    if (focused && focused !== control) focused.removeAttribute(FOCUS_ATTRIBUTE)
    focused = control
    if (!control) return
    ensureStyle(control.getRootNode?.() ?? control.ownerDocument)
    control.setAttribute(FOCUS_ATTRIBUTE, '')
    control.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  /** The preferred button of an entry (of the pop-up, without entries), else its first. */
  function entryControl(scope) {
    if (!scope) return null
    const controls = controlsIn(scope)
    return controls.find((control) => control.matches(spec.preferred)) ?? controls[0] ?? null
  }

  const live = () => Boolean(focused?.isConnected && rectOf(focused))

  return {
    /** Whether a button has the focus. */
    get active() {
      return live()
    },
    /** Whether the open pop-up has any button to focus. */
    available() {
      const node = root()
      return Boolean(node && controlsIn(node).length)
    },
    /** Focus the current entry's preferred button (Add to Anki). False when there is none. */
    enter() {
      const node = root()
      if (!node) return false
      const control = entryControl(currentEntry(node) ?? node) ?? controlsIn(node)[0] ?? null
      setFocus(control)
      return Boolean(control)
    },
    /** After the entries moved (a definition jump): the preferred button of the entry now current. */
    refocus() {
      if (!focused) return false
      const node = root()
      const control = node ? entryControl(currentEntry(node) ?? node) : null
      if (control) setFocus(control)
      return Boolean(control)
    },
    /** Move the focus to the nearest button in `dir`. False at the edge (the focus stays). */
    move(dir) {
      const node = root()
      if (!node) return false
      if (!live()) return this.enter()
      const controls = controlsIn(node)
      const index = nearestInDirection(rectOf(focused), controls.map(rectOf), dir)
      if (index < 0) return false
      setFocus(controls[index])
      return true
    },
    /** Click the focused button, as the mouse would. */
    press() {
      if (!live()) return false
      const control = focused
      control.setAttribute(FOCUS_ATTRIBUTE, 'pressed')
      setTimeout(() => {
        if (control === focused && control.isConnected) control.setAttribute(FOCUS_ATTRIBUTE, '')
      }, 140)
      control.click()
      return true
    },
    /** Click the play-audio button of the focused entry, else of the entry in view. */
    playAudio() {
      const node = root()
      if (!node) return false
      const entry = (live() && spec.entries && focused.closest?.(spec.entries)) || currentEntry(node)
      const button = visible(entry ?? node, spec.audio)[0]
      if (!button) return false
      button.click()
      return true
    },
    /** Take the focus ring away. */
    exit() {
      setFocus(null)
    }
  }
}

/**
 * Yomitan's pop-up (templates-display.html): each `.entry` has its action buttons — Add (one per
 * card format), Play audio, View added note. The menus and tag lists open dropdowns of their own,
 * which are not followed, so they are left out.
 * @type {FocusSpec}
 */
export const YOMITAN_FOCUS = {
  entries: '.entry',
  controls:
    '.action-button:not([data-action="menu"]):not([data-action="view-tags"]):not([data-action="view-flags"])',
  preferred: '[data-action="save-note"]',
  audio: '[data-action="play-audio"]',
  current: '.entry-current'
}

/**
 * Hachidori's pop-up (render/popup.js): the shown entry's Add/View note, pronunciation and word
 * status buttons sit in the pinned header (`showEntry` moves them there as the reader scrolls),
 * the rest beside each entry's headword.
 * @type {FocusSpec}
 */
export const HACHIDORI_FOCUS = {
  entries: null,
  controls:
    '.gsm-hoshidicts-mine-button, .gsm-hoshidicts-audio-button, .gsm-hoshidicts-word-status-button, .gsm-hoshidicts-note-button, .gsm-hoshidicts-custom-anki-button',
  preferred: '.gsm-hoshidicts-mine-button[data-action="add"]',
  audio: '.gsm-hoshidicts-audio-button'
}

export default { createPopupFocus, nearestInDirection, YOMITAN_FOCUS, HACHIDORI_FOCUS, FOCUS_ATTRIBUTE }
