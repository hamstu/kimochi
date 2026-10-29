/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Pointer diagnostics for bug reports, recorded only while verbose logging is on (Settings → About
 * → Verbose logging, `debug_verbose_set`). Nothing is sent, polled or kept while it is off.
 *
 * Written for hover and drag bugs that depend on the reader's devices: a pen tablet, a touchscreen
 * or a second mouse is a pointer of its own in the webview, and Chromium's `:hover` follows
 * whichever moved last. Each record goes to `evidence.jsonl` (`report`) as
 * `check: 'pointer-trace'`:
 *
 * - `window`: each time logging starts in a window. The page's own geometry (devicePixelRatio,
 *   screenX/Y, inner and outer size, the CSS pointer media queries) beside native's (`inspect`:
 *   DPI, window and client rectangles), so a coordinate mismatch is visible at a glance.
 * - `pointerdown`, `pointerup`, `pointercancel`: every one. `pointermove`: at most one per
 *   `MOVE_MS` per pointer, so two interleaved streams both show. Each with the pointer's type, id,
 *   primary and trusted flags, buttons, client point and the element's tag and classes.
 * - `hover`: whenever the deepest `:hover` element changes, and (where the native hover bridge
 *   runs) the deepest `[data-native-hover]` one.
 *
 * Elements are described by tag, id, classes, role and aria-label only, never their text: an
 * overlay's text is the reader's game.
 *
 * Callers with their own events (the region editor's gestures) send them through `pointerTrace`.
 */

/** At most one move per pointer per this many milliseconds. */
const MOVE_MS = 200
/** How often the hovered elements are compared while logging is on. */
const HOVER_MS = 250

const tauri = () => globalThis.__TAURI__
let verbose = false
let watching = false
const listeners = new Set()

function setVerbose(next) {
  const on = next === true
  if (on === verbose) return
  verbose = on
  for (const listener of listeners) listener(on)
}

/** Follow the verbose logging switch: its state now, and `verbose-logging` when it changes. */
function watchVerbose() {
  if (watching) return
  watching = true
  const api = tauri()
  if (!api?.core?.invoke) return
  // Without `enabled`, `debug_verbose_set` only answers whether it is on.
  void api.core.invoke('debug_verbose_set').then(setVerbose, () => undefined)
  void api.event?.listen?.('verbose-logging', ({ payload }) => setVerbose(payload))?.catch?.(() => undefined)
}

/** Whether verbose logging is on (as far as this window knows). */
export const pointerTracing = () => verbose

/**
 * Record one diagnostic, only while verbose logging is on.
 * @param {string} where
 * @param {Record<string, unknown>} value
 */
export function pointerTrace(where, value) {
  if (!verbose) return
  try {
    void tauri()
      ?.core?.invoke('report', { value: { check: 'pointer-trace', where, ...value } })
      ?.catch?.(() => undefined)
  } catch {
    // No native side (the browser preview): nothing to record to.
  }
}

/** An element as tag, id, classes, role and label: never its text. */
export function describeElement(element) {
  if (!element || element.nodeType !== 1) return null
  const classes =
    typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : []
  const role = element.getAttribute?.('role')
  const label = element.getAttribute?.('aria-label')
  return (
    element.tagName.toLowerCase() +
    (element.id ? `#${element.id}` : '') +
    classes.map((name) => `.${name}`).join('') +
    (role ? `[role=${role}]` : '') +
    (label ? `[aria-label="${label.slice(0, 40)}"]` : '')
  )
}

const deepest = (selector) => {
  const all = document.querySelectorAll(selector)
  return all.length ? all[all.length - 1] : null
}

const round = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : value)

function windowRecord(label) {
  const media = (query) => {
    try {
      return matchMedia(query).matches
    } catch {
      return null
    }
  }
  const record = {
    type: 'window',
    dpr: globalThis.devicePixelRatio,
    screenXY: [globalThis.screenX, globalThis.screenY],
    inner: [globalThis.innerWidth, globalThis.innerHeight],
    outer: [globalThis.outerWidth, globalThis.outerHeight],
    screen: [globalThis.screen?.width, globalThis.screen?.height],
    maxTouchPoints: navigator.maxTouchPoints,
    // What the page believes about its pointers: a pen or touchscreen shows up as `coarse` or
    // `any-pointer: coarse`.
    pointer: {
      fine: media('(pointer: fine)'),
      coarse: media('(pointer: coarse)'),
      anyFine: media('(any-pointer: fine)'),
      anyCoarse: media('(any-pointer: coarse)'),
      hover: media('(hover: hover)'),
      anyHover: media('(any-hover: hover)')
    }
  }
  if (!label) return Promise.resolve(record)
  return Promise.resolve(tauri()?.core?.invoke('panel', { label, action: 'inspect', rect: null }))
    .then((info) => {
      const native = info?.native ?? {}
      return {
        ...record,
        native: {
          scale: info?.scale ?? native.dpi_scale ?? null,
          dpi: native.dpi ?? null,
          windowRect: native.window_rect ?? null,
          clientRect: native.client_rect ?? null,
          focused: info?.focused ?? null
        }
      }
    })
    .catch(() => record)
}

/**
 * Starts recording this window's pointer events and hover whenever verbose logging is on.
 * `label` is the window's panel label, for its native geometry; `active` limits recording to
 * when it returns true (the overlay records only while its region editor is open). Returns a
 * function that stops it.
 *
 * @param {string} where
 * @param {{label?: string | null, active?: () => boolean}} [options]
 * @returns {() => void}
 */
export function installPointerDiagnostics(where, { label = null, active = () => true } = {}) {
  watchVerbose()
  const lastMove = new Map()
  let hoverTimer = 0
  let lastHover = ''

  const onEvent = (event) => {
    if (!verbose || !active()) return
    if (event.type === 'pointermove') {
      const key = `${event.pointerType}:${event.pointerId}:${event.isTrusted}`
      const now = performance.now()
      if (now - (lastMove.get(key) ?? -Infinity) < MOVE_MS) return
      lastMove.set(key, now)
    }
    pointerTrace(where, {
      type: event.type,
      pointerType: event.pointerType,
      pointerId: event.pointerId,
      isPrimary: event.isPrimary,
      isTrusted: event.isTrusted,
      button: event.button,
      buttons: event.buttons,
      client: [round(event.clientX), round(event.clientY)],
      target: describeElement(event.target)
    })
  }

  const checkHover = () => {
    if (!active()) return
    const hover = describeElement(deepest(':hover'))
    const nativeHover = describeElement(deepest('[data-native-hover]'))
    const key = `${hover}|${nativeHover}`
    if (key === lastHover) return
    lastHover = key
    pointerTrace(where, { type: 'hover', hover, nativeHover })
  }

  const start = () => {
    void windowRecord(label).then((record) => pointerTrace(where, record))
    lastHover = ''
    clearInterval(hoverTimer)
    hoverTimer = setInterval(checkHover, HOVER_MS)
  }
  const stop = () => {
    clearInterval(hoverTimer)
    hoverTimer = 0
  }
  const onVerbose = (on) => (on ? start() : stop())

  const types = ['pointerdown', 'pointerup', 'pointercancel', 'pointermove']
  for (const type of types) window.addEventListener(type, onEvent, { capture: true, passive: true })
  listeners.add(onVerbose)
  if (verbose) start()
  return () => {
    for (const type of types) window.removeEventListener(type, onEvent, { capture: true })
    listeners.delete(onVerbose)
    stop()
  }
}
