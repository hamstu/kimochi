/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Read along's control bar (ui/controller.js `showHud`): where it goes, and what is in it.
 *
 * Where: a source in a window, with desktop around it, has the bar outside the window, below it,
 * or above it where the window reaches the bottom of the display; a full-screen source (or one
 * whose bounds are unknown) has it inside along the bottom, as it always had. Wherever it goes, it
 * never covers the line being read: a place that would is skipped for the next one (`placeBar`).
 *
 * What: `readAlongBar` in settings (Settings → Overlay → Read along bar): whether it shows at all
 * (`shown`), the position counter (`counter`), and the shortcut hints (`hints`: every one, the
 * basics only, or none). This file is plain JS with no imports, loaded unbundled by tests.
 */

/** The same as `DEFAULT_READ_ALONG_BAR` in ui/settings.ts (scripts/read-along-bar.test.mjs checks). */
export const READ_ALONG_BAR_DEFAULTS = Object.freeze({ shown: true, counter: true, hints: 'all' })

/** Which hints the bar shows: every one, only stepping, looking up and going back, or none. */
export const BAR_HINTS = Object.freeze(['all', 'basic', 'none'])

/** `readAlongBar` as stored, with defaults for anything missing or unknown. */
export function readAlongBarSettings(value) {
  const stored = value && typeof value === 'object' ? value : {}
  return {
    shown: typeof stored.shown === 'boolean' ? stored.shown : READ_ALONG_BAR_DEFAULTS.shown,
    counter: typeof stored.counter === 'boolean' ? stored.counter : READ_ALONG_BAR_DEFAULTS.counter,
    hints: BAR_HINTS.includes(stored.hints) ? stored.hints : READ_ALONG_BAR_DEFAULTS.hints
  }
}

/**
 * The hints to draw: `hints` as `{html, basic}` (basic: stepping, looking up, going back), kept
 * by the setting (`level`, one of `BAR_HINTS`).
 * @param {{html: string, basic?: boolean}[]} hints
 * @param {string} level
 */
export function barHints(hints, level) {
  if (level === 'none') return ''
  return hints
    .filter((hint) => level !== 'basic' || hint.basic)
    .map((hint) => hint.html)
    .join('')
}

/** The gap between the bar and the window's edge, outside it. */
const GAP_OUTSIDE = 10
/** The gap between the bar and the source's edge, inside it (the bar's old place: 64 from its top). */
const GAP_INSIDE = 20
/** The least room kept between the bar and the display's edge. */
const MARGIN = 8
/** How far around the line being read counts as on it. */
const CLEARANCE = 4
/** A source covering this much of the display both ways is full screen: no room outside it. */
const FULL = 0.9

const overlaps = (a, b) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height

/**
 * Where the bar goes: `{x, y, edge}`, x its centre and y its top in overlay coordinates, and
 * `edge` one of 'below' / 'above' (outside the window) or 'bottom' / 'top' (inside the source).
 *
 * @param {object} options
 * @param {{width: number, height: number}} options.view the overlay (the display the source is on)
 * @param {{x: number, y: number, width: number, height: number} | null} options.area the source
 *   window's bounds in overlay coordinates; null when unknown
 * @param {boolean} [options.fullscreen] the source is full screen (native says so)
 * @param {{width: number, height: number}} options.size the bar's own size
 * @param {{left: number, top: number, width: number, height: number}[]} [options.avoid] the line
 *   being read, one rectangle per piece
 */
export function placeBar({ view, area, fullscreen = false, size, avoid = [] }) {
  const { width, height } = size
  // The part of the source on this display (a window may hang off it, or onto another one).
  const source = area
    ? (() => {
        const left = Math.max(0, area.x)
        const top = Math.max(0, area.y)
        const right = Math.min(view.width, area.x + area.width)
        const bottom = Math.min(view.height, area.y + area.height)
        return right > left && bottom > top ? { left, top, right, bottom } : null
      })()
    : null
  const bounds = source ?? { left: 0, top: 0, right: view.width, bottom: view.height }
  const windowed =
    Boolean(area && source) && !fullscreen && !(area.width >= view.width * FULL && area.height >= view.height * FULL)
  const centre = Math.max(
    width / 2 + MARGIN,
    Math.min(view.width - width / 2 - MARGIN, (bounds.left + bounds.right) / 2)
  )
  const inside = (y) => Math.max(MARGIN, Math.min(view.height - height - MARGIN, y))
  const candidates = [
    ...(windowed
      ? [
          { edge: 'below', y: area.y + area.height + GAP_OUTSIDE },
          { edge: 'above', y: area.y - GAP_OUTSIDE - height }
        ].filter(({ y }) => y >= MARGIN && y + height + MARGIN <= view.height)
      : []),
    { edge: 'bottom', y: inside(bounds.bottom - GAP_INSIDE - height) },
    { edge: 'top', y: inside(bounds.top + GAP_INSIDE) }
  ]
  const clear = candidates.find(({ y }) => {
    const bar = { left: centre - width / 2, top: y, width, height }
    return !avoid.some((rect) =>
      overlaps(bar, {
        left: rect.left - CLEARANCE,
        top: rect.top - CLEARANCE,
        width: rect.width + CLEARANCE * 2,
        height: rect.height + CLEARANCE * 2
      })
    )
  })
  const chosen = clear ?? candidates[0]
  return { x: Math.round(centre), y: Math.round(chosen.y), edge: chosen.edge }
}
