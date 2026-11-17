/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS, shared with the Node tests. */
/**
 * What the buttons are called on the controller in use. Indices are the standard (W3C) layout
 * every source reports in; only the names printed on the pad differ. Xbox-style names (the Steam
 * Deck's) are the default; a PlayStation pad, known by Sony's USB vendor ID or by its name, gets
 * its own: Cross, Circle, Square and Triangle, L1/R1, L2/R2, Create or Share, Options.
 *
 * Shared by the overlay (ui/controller-input.js) and the React windows (frontend/bridge/useGamepad.ts).
 * The layout is one value per window, set from the native `gamepad` state's active controller.
 */

/** @typedef {'xbox' | 'dualsense' | 'dualshock'} PadLayout */
/** @typedef {{ id?: string | null, vendor?: string | null, product?: string | null, index?: number }} PadIdentity */

const SONY_VENDOR = '054c'
/** DualShock 4 (both revisions); every other Sony product reads as the current pad, the DualSense. */
const DUALSHOCK_PRODUCTS = new Set(['05c4', '09cc', '0ba0'])

/**
 * The layout a controller prints on its buttons, from its name and, where known, USB IDs.
 * @param {PadIdentity | null | undefined} pad
 * @returns {PadLayout}
 */
export function padLayoutOf(pad) {
  if (!pad) return 'xbox'
  const name = String(pad.id ?? '')
  const vendor = String(pad.vendor ?? '').toLowerCase()
  const product = String(pad.product ?? '').toLowerCase()
  // A browser id carries the IDs in its text: "DualSense Wireless Controller (… Vendor: 054c Product: 0ce6)".
  const idVendor = /vendor:\s*([0-9a-f]{4})/i.exec(name)?.[1]?.toLowerCase()
  const idProduct = /product:\s*([0-9a-f]{4})/i.exec(name)?.[1]?.toLowerCase()
  const sony = vendor === SONY_VENDOR || idVendor === SONY_VENDOR
  if (/dualshock|\bps4\b/i.test(name)) return 'dualshock'
  if (/dualsense|\bps5\b/i.test(name)) return 'dualsense'
  if (sony || /playstation|\bps3\b|sony/i.test(name)) {
    return DUALSHOCK_PRODUCTS.has(product || idProduct || '') ? 'dualshock' : 'dualsense'
  }
  return 'xbox'
}

/**
 * The active controller's layout in a `gamepad` state, or null when none is active.
 * @param {{ gamepads?: PadIdentity[] | null, activeGamepadIndex?: number | null } | null | undefined} state
 * @returns {PadLayout | null}
 */
export function activePadLayout(state) {
  const index = state?.activeGamepadIndex
  if (index == null) return null
  const pad = state?.gamepads?.find((device, at) => (device.index ?? at) === index)
  return pad ? padLayoutOf(pad) : null
}

/** Xbox-style names, by standard index; the Steam Deck's own extras follow the standard 17. */
const XBOX = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'View',
  'Menu',
  'LS',
  'RS',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  // What only the Steam Deck has, read from its own controller (deck_input.rs): the back grips
  // (upper L4 and R4, lower L5 and R5) and the trackpad clicks.
  'L4',
  'R4',
  'L5',
  'R5',
  'Left pad',
  'Right pad'
]

/** The names a PlayStation pad prints, where they differ from the Xbox ones. */
/** @type {Record<number, string>} */
const PLAYSTATION = {
  0: '✕',
  1: '○',
  2: '□',
  3: '△',
  4: 'L1',
  5: 'R1',
  6: 'L2',
  7: 'R2',
  9: 'Options',
  10: 'L3',
  11: 'R3',
  16: 'PS'
}

/**
 * Every button's name in a layout, by standard index.
 * @param {PadLayout} layout
 * @returns {string[]}
 */
export function padButtonNames(layout) {
  if (layout === 'xbox') return [...XBOX]
  const view = layout === 'dualshock' ? 'Share' : 'Create'
  return XBOX.map((name, index) => (index === 8 ? view : (PLAYSTATION[index] ?? name)))
}

/** @type {PadLayout} */
let current = 'xbox'
/** @type {Set<() => void>} */
const listeners = new Set()

/**
 * This window's layout: the active controller's, or Xbox-style until one is known.
 * @returns {PadLayout}
 */
export function padLayout() {
  return current
}

/**
 * Change this window's layout; a null (no controller active) keeps the last one.
 * @param {PadLayout | null} layout
 */
export function setPadLayout(layout) {
  if (!layout || layout === current) return
  current = layout
  for (const listener of listeners) listener()
}

/**
 * Be told when the layout changes; returns the unsubscribe.
 * @param {() => void} listener
 * @returns {() => void}
 */
export function onPadLayout(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The PlayStation face symbols, drawn rather than typed: font characters (✕ ○ □ △) come in
 * whatever size and weight the font gives each, so the cross looked small beside the circle. Here
 * all four share one 24×24 square and one stroke, sized to look the same (a square reads larger
 * than a circle of the same width, a cross smaller), and follow the text colour.
 * Each is a list of SVG elements, `[tag, attributes]`, so React can draw them too.
 * @type {Record<string, { label: string, shapes: [string, Record<string, string | number>][] }>}
 */
export const PAD_SYMBOLS = {
  '✕': { label: 'Cross', shapes: [['path', { d: 'M5 5 19 19M19 5 5 19' }]] },
  '○': { label: 'Circle', shapes: [['circle', { cx: 12, cy: 12, r: 7.9 }]] },
  '□': { label: 'Square', shapes: [['rect', { x: 5, y: 5, width: 14, height: 14, rx: 0.6 }]] },
  '△': { label: 'Triangle', shapes: [['path', { d: 'M12 4.2 20.2 18.4H3.8Z' }]] }
}

/** What every symbol's `<svg>` carries: the shared square and stroke. */
export const PAD_SYMBOL_SVG = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2.5,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round'
}

/** How a run of text with symbols in it lays out (`padGlyphHtml`, PadText). */
export const PAD_RUN_STYLE = 'display:inline-flex;align-items:center;white-space:pre;vertical-align:middle'

/** Splits text around the symbols, keeping them: "L1 + ✕" → ["L1 + ", "✕", ""]. */
export const PAD_SYMBOL_SPLIT = /([✕○□△])/

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const attributes = (values) =>
  Object.entries(values)
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(' ')

/**
 * One symbol as SVG markup, sized to the text around it (`em`), or null for anything else.
 * @param {string} symbol
 * @returns {string | null}
 */
export function padSymbolSvg(symbol) {
  const known = PAD_SYMBOLS[symbol]
  if (!known) return null
  const shapes = known.shapes.map(([tag, values]) => `<${tag} ${attributes(values)}/>`).join('')
  return `<svg class="pad-symbol" role="img" aria-label="${known.label}" width="1.2em" height="1.2em" style="display:block;flex:none" ${attributes(PAD_SYMBOL_SVG)}>${shapes}</svg>`
}

/**
 * Text as HTML, escaped, with any PlayStation symbol in it drawn (`padSymbolSvg`): for a button's
 * name in a hint, "✕" or "L1 + ✕" as much as "A".
 * @param {unknown} text
 * @returns {string}
 */
export function padGlyphHtml(text) {
  const parts = String(text ?? '')
    .split(PAD_SYMBOL_SPLIT)
    .filter(Boolean)
  const html = parts.map((part) => padSymbolSvg(part) ?? escapeHtml(part)).join('')
  // A run of its own that centres the symbols on the text, not on its baseline, whatever holds
  // it (a flex <kbd>, a line of text); its spaces kept ("L1 + ✕", not "L1 +✕").
  return parts.some((part) => PAD_SYMBOLS[part]) ? `<span style="${PAD_RUN_STYLE}">${html}</span>` : html
}
