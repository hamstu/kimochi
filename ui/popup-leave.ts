/**
 * When the overlay's dictionary pop-up should close because the pointer has left it.
 *
 * Yomitan keeps its pop-up until another lookup or a click, and over a game that click also
 * reaches the game (a visual novel advances on it). On Windows a hover no longer takes the
 * keyboard either (mouseguard.rs), so Escape goes to the game too. The overlay therefore closes
 * the pop-up itself once the pointer has been off every word and off the pop-up for `graceMs`:
 * long enough to cross the gap between a word and its pop-up, short enough to read as "it went
 * away when I moved on".
 */
export interface LeaveRect {
  x: number
  y: number
  width: number
  height: number
}

export class PopupLeave {
  private awaySince: number | null = null

  constructor(readonly graceMs = 600) {}

  /** True exactly once, when the open pop-up should close. `rects` are the words and the pop-up. */
  update(now: number, pointer: { x: number; y: number } | null, rects: LeaveRect[], popupOpen: boolean): boolean {
    const inside = pointer !== null && rects.some((r) => inRect(r, pointer.x, pointer.y))
    if (!popupOpen || inside) {
      this.awaySince = null
      return false
    }
    this.awaySince ??= now
    if (now - this.awaySince < this.graceMs) return false
    this.awaySince = null
    return true
  }

  /** How long until `update` could next say "close", or null when nothing is pending. */
  remaining(now: number): number | null {
    return this.awaySince === null ? null : Math.max(0, this.graceMs - (now - this.awaySince))
  }
}

/** Whether a point is inside a rectangle (its far edges excluded). */
export function inRect(r: LeaveRect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

/** How far the next word on a line may be, in the text's size, for a hover pop-up to stay open on the way. */
export const LINE_GAP_EM = 2

/**
 * The line a matched word is on, and only that line (look up on hover keeps its pop-up while the
 * pointer is on it): the word's own band (its height, or its width for vertical text) across the
 * box under its middle (`boxes`, the overlay's text boxes) and the boxes on the same row that OCR
 * split off it, joined so the gaps between them count too. A box holding several lines, or a
 * grouped region, gives only the word's row. A box more than `LINE_GAP_EM` × `em` past the last
 * is another text. `drawn` is the line's text as drawn, which may run past its box (Yomitan looks
 * up on every glyph). Null where no box is under the word and nothing is drawn.
 */
export function lineAround(
  word: LeaveRect,
  boxes: LeaveRect[],
  drawn: LeaveRect[],
  vertical: boolean,
  em: number
): LeaveRect | null {
  const cx = word.x + word.width / 2
  const cy = word.y + word.height / 2
  // Along the line: [start, end) of a rect; across it, whether the word's middle is inside.
  const along = (r: LeaveRect): [number, number] => (vertical ? [r.y, r.y + r.height] : [r.x, r.x + r.width])
  const onRow = (r: LeaveRect): boolean =>
    vertical ? cx >= r.x && cx < r.x + r.width : cy >= r.y && cy < r.y + r.height
  const home = boxes.find((r) => inRect(r, cx, cy))
  let [start, end] = home ? along(home) : along(word)
  if (home) {
    // One sweep each way from the word's box, over the row's boxes in order along the line.
    const row = boxes.filter(onRow).map(along)
    const reach = LINE_GAP_EM * em
    for (const [lo, hi] of row.sort((a, b) => a[0] - b[0])) if (lo - end <= reach) end = Math.max(end, hi)
    for (const [lo, hi] of row.sort((a, b) => b[1] - a[1])) if (start - hi <= reach) start = Math.min(start, lo)
  } else if (drawn.length === 0) return null
  for (const r of drawn.filter(onRow)) {
    const [lo, hi] = along(r)
    start = Math.min(start, lo)
    end = Math.max(end, hi)
  }
  return vertical
    ? { x: word.x, y: start, width: word.width, height: end - start }
    : { x: start, y: word.y, width: end - start, height: word.height }
}

/**
 * The space between a word (or its line) and its pop-up: along the axis they are apart on, the
 * gap between them; along the other, both their extents. Apart on both (diagonal), the box around
 * the two. A pixel of slack each way, for rounding at the edges.
 */
export function gapBetween(word: LeaveRect, popup: LeaveRect): LeaveRect {
  const apart = (lo1: number, hi1: number, lo2: number, hi2: number): boolean => hi1 <= lo2 || hi2 <= lo1
  const xApart = apart(word.x, word.x + word.width, popup.x, popup.x + popup.width)
  const yApart = apart(word.y, word.y + word.height, popup.y, popup.y + popup.height)
  const span = (lo1: number, hi1: number, lo2: number, hi2: number, gapOnly: boolean): [number, number] =>
    gapOnly ? [Math.min(hi1, hi2), Math.max(lo1, lo2)] : [Math.min(lo1, lo2), Math.max(hi1, hi2)]
  const [x0, x1] = span(word.x, word.x + word.width, popup.x, popup.x + popup.width, xApart && !yApart)
  const [y0, y1] = span(word.y, word.y + word.height, popup.y, popup.y + popup.height, yApart && !xApart)
  return { x: x0 - 1, y: y0 - 1, width: x1 - x0 + 2, height: y1 - y0 + 2 }
}
