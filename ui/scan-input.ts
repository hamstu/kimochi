/**
 * Turning a native cursor sample into the event Yomitan's scanner is waiting for.
 *
 * The overlay lies over somebody else's window, and while they are reading it, that
 * window owns both the pointer and the keyboard. The overlay is click-through
 * everywhere except over the words themselves, so it receives no `mousemove`, and it
 * is not the key window, so it receives no `keydown` — which is why a lookup used to
 * need a click first, and why the click was worth complaining about: it activated
 * this application, and activating an application reorders every window it owns in
 * front of the one being read.
 *
 * Native reads the pointer and the held modifiers from the window server instead, for
 * which neither focus nor a grant is required, and this turns one such sample into an
 * ordinary `pointermove`. `TextScanner` reads the trigger modifier straight off the
 * pointer event it is already listening for, so the original scanner then behaves
 * exactly as it does in a browser, with no window having taken anything.
 */

/** One sample from the native cursor poll; see `spawn_cursor_poll` in `main.rs`. */
export interface PointerSample {
  /** Desktop points. */
  x: number
  y: number
  /** Whether the pointer is over the display the overlay covers. */
  over?: boolean
  /** Another window — the dictionary — claims this point. */
  blocked?: boolean
  down?: boolean
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
  meta?: boolean
}

/** The subset of `PointerEventInit` this produces. */
export interface ScanPointerInit {
  pointerType: 'mouse'
  isPrimary: true
  bubbles: true
  cancelable: true
  clientX: number
  clientY: number
  screenX: number
  screenY: number
  buttons: number
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * How long a real pointer event keeps the native feed quiet.
 *
 * Over a word the overlay does hold the mouse, and then its own events are the better
 * answer — they are the actual pointer rather than a 32 ms-old reading of it. Long
 * enough to cover the gap between two real moves, short enough that the feed takes
 * over again as soon as the pointer leaves the part of the window that has the mouse.
 */
export const REAL_POINTER_GRACE_MS = 250

/** The modifiers a real pointer event reported; see `scanPointerInit`. */
export interface HeldModifiers {
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

/**
 * Whether the sample holds a modifier the last real event did not report.
 *
 * A real event is only the better answer if it knows what the native sample knows. On
 * Windows it often does not: the overlay is not the window with the keyboard, so its
 * events can report every modifier as up while the game has focus, even with Shift held.
 * Muting the native sample then discards the only correct reading of the trigger key, and
 * since the feed sends nothing new until the pointer moves or a modifier changes, the
 * lookup never happens: moving onto a word with Shift already held did nothing. Where the
 * real event does carry the modifiers (it reports the same keys), it still wins.
 */
function addsModifier(sample: PointerSample, real: HeldModifiers | null): boolean {
  return (
    (!!sample.shift && !real?.shiftKey) ||
    (!!sample.ctrl && !real?.ctrlKey) ||
    (!!sample.alt && !real?.altKey) ||
    (!!sample.meta && !real?.metaKey)
  )
}

/**
 * The event to dispatch for this sample, or `null` to dispatch nothing.
 *
 * `local` is the sample translated into the overlay's own coordinates; see
 * `toOverlayLocal`. It is passed in rather than computed here so that this stays one
 * decision — whether to speak at all — and the translation stays the one place that
 * knows where the window is. `real` is the modifiers the last real pointer event carried.
 */
export function scanPointerInit(
  sample: PointerSample,
  local: { x: number; y: number } | null,
  sinceRealPointer: number,
  real: HeldModifiers | null = null
): ScanPointerInit | null {
  // No window, no coordinates, nothing to scan.
  if (!local) return null
  // Off the overlay's display entirely: the proximity effect fades, and a scan there
  // would be a scan of a point this window does not cover.
  if (sample.over === false) return null
  // The dictionary floats above the overlay, so a point inside it is over the popup's
  // own text. Scanning through it would look up whatever the popup is covering.
  if (sample.blocked) return null
  if (sinceRealPointer < REAL_POINTER_GRACE_MS && !addsModifier(sample, real)) return null
  return {
    pointerType: 'mouse',
    isPrimary: true,
    bubbles: true,
    cancelable: true,
    clientX: local.x,
    clientY: local.y,
    // Desktop points are what a screen coordinate means, and a scan that reports its
    // own position gets it right for free.
    screenX: sample.x,
    screenY: sample.y,
    buttons: sample.down ? 1 : 0,
    shiftKey: !!sample.shift,
    ctrlKey: !!sample.ctrl,
    altKey: !!sample.alt,
    metaKey: !!sample.meta
  }
}
