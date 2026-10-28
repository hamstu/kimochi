/**
 * One press per tap on WebKitGTK touchscreens (the Steam Deck in Gaming Mode).
 *
 * With Gamescope's touch mode at Passthrough, WebKitGTK sees real touches on XWayland, and two
 * things then reach the page twice: GTK hands it every touch-begin and touch-update twice (same
 * point, same time), and WebKitGTK's own tap gesture follows the touch's pointer events with
 * emulated mouse ones (`pointerType: 'mouse'`, mousedown/up) on the same spot. Radix's
 * DropdownMenu toggles on `pointerdown`, so either one opens a menu and shuts it again before the
 * finger lifts; a doubled `click` does the same to a Popover.
 *
 * This drops, in the capture phase on the window (before React and Radix see anything):
 * - an exact duplicate: the same event type for the same pointer or touch, within a pixel of the
 *   last one and within `DUPLICATE_MS` of it;
 * - a mouse event that follows a touch pointer on the same spot (`GHOST_MS`, `GHOST_PX`): the
 *   emulated mouse of a tap;
 * - a second `click` on the same spot soon after a touch (`CLICK_MS`).
 *
 * Dropped events are stopped, not cancelled, so their default actions still happen once (a tapped
 * text field takes focus from the emulated mousedown). The exception is an emulated mousedown on
 * anything else: its default action would move focus to the trigger under the finger, out of a
 * menu that has just opened, and Radix closes a menu that loses focus. It acts on Linux, and
 * anywhere else only once a touch has been seen, so desktop mice elsewhere are untouched.
 *
 * Diagnostics: `localStorage['kimochi.debugPointer'] = '1'` reports each press, release, click
 * and touch to the app's evidence log (`check: 'pointer-debug'`) with whether it was dropped.
 */

export const DUPLICATE_MS = 40
export const GHOST_MS = 800
export const GHOST_PX = 32
export const CLICK_MS = 400

export type PointerVerdict = 'pass' | 'duplicate' | 'ghost'

/** The fields read off a DOM event; a `PointerEvent`, `MouseEvent` or `TouchEvent` all fit. */
export interface InputEventLike {
  type: string
  timeStamp: number
  pointerType?: string
  pointerId?: number
  clientX?: number
  clientY?: number
  changedTouches?: ArrayLike<{ identifier: number; clientX: number; clientY: number }>
}

interface Seen {
  id: string
  x: number
  y: number
  t: number
}

/** The events this filters. Others pass untouched. */
export const FILTERED = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointercancel',
  'mousedown',
  'mouseup',
  'mousemove',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'click'
] as const

/** The events a diagnostic session reports. */
export const REPORTED = new Set(['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'mousedown', 'mouseup'])

const isTouch = (event: InputEventLike): boolean =>
  event.type.startsWith('touch') || (event.type.startsWith('pointer') && event.pointerType === 'touch')

/** Emulated mouse input: a mouse pointer event or a compatibility mouse event. */
const isMouse = (event: InputEventLike): boolean =>
  event.type.startsWith('mouse') || (event.type.startsWith('pointer') && event.pointerType === 'mouse')

/** Where the event is and which pointer or touch it belongs to. */
export function describe(event: InputEventLike): Seen {
  const touch = event.changedTouches?.[0]
  if (touch) return { id: `touch:${touch.identifier}`, x: touch.clientX, y: touch.clientY, t: event.timeStamp }
  const id = event.type.startsWith('pointer') ? `${event.pointerType ?? ''}:${event.pointerId ?? ''}` : event.type
  return { id, x: event.clientX ?? 0, y: event.clientY ?? 0, t: event.timeStamp }
}

const near = (a: Seen, b: Seen, px: number): boolean => Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px
const within = (a: Seen, b: Seen, ms: number): boolean => Math.abs(a.t - b.t) <= ms

/**
 * The filter's memory and rules, apart from the DOM. `active` false lets everything pass until a
 * touch is seen.
 */
export function createPointerFilter({ active = true }: { active?: boolean } = {}): {
  classify: (event: InputEventLike) => PointerVerdict
} {
  let touchSeen = false
  const last = new Map<string, Seen>()
  let touchPointer: Seen | null = null
  let touch: Seen | null = null
  let click: Seen | null = null
  return {
    classify(event) {
      if (isTouch(event)) touchSeen = true
      if (!active && !touchSeen) return 'pass'
      const seen = describe(event)
      const previous = last.get(event.type)
      if (previous && previous.id === seen.id && near(previous, seen, 1) && within(previous, seen, DUPLICATE_MS)) {
        return 'duplicate'
      }
      last.set(event.type, seen)
      if (isTouch(event)) {
        touch = seen
        if (event.type.startsWith('pointer')) touchPointer = seen
        return 'pass'
      }
      if (isMouse(event) && touchPointer && within(touchPointer, seen, GHOST_MS) && near(touchPointer, seen, GHOST_PX)) {
        return 'ghost'
      }
      if (event.type === 'click') {
        const repeat = click && touch && within(touch, seen, GHOST_MS) && within(click, seen, CLICK_MS) && near(click, seen, GHOST_PX)
        if (repeat) return 'duplicate'
        click = seen
      }
      return 'pass'
    }
  }
}

/** Elements that take focus from a press, which a tap's emulated mousedown still gives them. */
const FOCUS_ON_PRESS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

const editable = (target: EventTarget | null): boolean =>
  typeof (target as Element | null)?.closest === 'function' && (target as Element).closest(FOCUS_ON_PRESS) !== null

interface Target {
  addEventListener: (type: string, listener: (event: Event) => void, options: AddEventListenerOptions) => void
  removeEventListener: (type: string, listener: (event: Event) => void, options: AddEventListenerOptions) => void
}

export interface InstallOptions {
  /** Filter from the start (Linux) rather than from the first touch. */
  active?: boolean
  /** Report each press, release, click and touch with its verdict. */
  debug?: boolean
  report?: (value: Record<string, unknown>) => void
}

/** Filters `target`'s input in the capture phase; returns the uninstall. */
export function installPointerFilter(target: Target, { active, debug = false, report }: InstallOptions = {}): () => void {
  const filter = createPointerFilter({ active })
  const listener = (event: Event): void => {
    // Events the app dispatches itself (the overlay's scan pointer) are never doubled input.
    if (!event.isTrusted) return
    const verdict = filter.classify(event as unknown as InputEventLike)
    if (verdict !== 'pass') event.stopImmediatePropagation()
    if (verdict === 'ghost' && event.type === 'mousedown' && !editable(event.target)) event.preventDefault()
    if (debug && report && REPORTED.has(event.type)) {
      const { id, x, y, t } = describe(event as unknown as InputEventLike)
      const pointerType = (event as unknown as InputEventLike).pointerType
      report({ check: 'pointer-debug', type: event.type, pointerType, id, x, y, t: Math.round(t * 10) / 10, verdict })
    }
  }
  // Touch listeners stay passive so scrolling never waits on this; only a mousedown is cancelled.
  const options = (type: string): AddEventListenerOptions => ({ capture: true, passive: type.startsWith('touch') })
  for (const type of FILTERED) target.addEventListener(type, listener, options(type))
  return () => {
    for (const type of FILTERED) target.removeEventListener(type, listener, options(type))
  }
}

let installed = false

/** Once per window, at its entry, before anything else listens. */
export function installPointerDedupe(win: Window = window): void {
  if (installed || typeof win === 'undefined') return
  installed = true
  let debug = false
  try {
    debug = win.localStorage.getItem('kimochi.debugPointer') === '1'
  } catch {
    /* No storage: no diagnostics. */
  }
  const tauri = win as unknown as {
    __TAURI__?: { core?: { invoke?: (command: string, args: unknown) => Promise<unknown> } }
    __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } }
  }
  const label = tauri.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? win.location.pathname
  const invoke = tauri.__TAURI__?.core?.invoke
  const report = (value: Record<string, unknown>): void => {
    if (invoke) void invoke('report', { value: { window: label, ...value } }).catch(() => undefined)
    else console.debug('[pointer]', value)
  }
  const ua = win.navigator.userAgent
  installPointerFilter(win, { active: /Linux/.test(ua) && !/Android/.test(ua), debug, report })
}
