/**
 * Desktop geometry for the dictionary popup's own window.
 *
 * The popup is the original extension's, rendered by the original `Popup` into an
 * iframe. What changes here is only *where that iframe is*: instead of being an
 * absolutely positioned element clipped to whichever panel owns the scanned text, it
 * is placed in a small borderless window of its own, and the window is moved to it.
 *
 * Yomitan still decides the position. `Popup._getPosition` takes a viewport and
 * returns a rectangle inside it, applying its own above/below preference, its
 * configured offsets, and its clamp to the edges. Hand it the *work area of the
 * display the scanned text is on*, in desktop points, and it answers in desktop
 * points — flip and clamp included, against the real screen rather than against a
 * 720-point-wide log window. That is the whole trick, and it is why the rules below
 * are about choosing a display and unioning rectangles, not about placing a popup.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The shape Yomitan uses for rectangles it passes around: edges, not origin and size.
 * `Popup.showContent`'s `sourceRects` are these.
 */
export interface Edges {
  left: number
  top: number
  right: number
  bottom: number
}

/** The shape `Popup._getPosition` wants a viewport in. */
export interface Viewport {
  left: number
  top: number
  right: number
  bottom: number
}

export interface DisplayArea {
  work_area: Rect
}

const centre = (rect: Rect): { x: number; y: number } => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2
})

const contains = (area: Rect, point: { x: number; y: number }): boolean =>
  point.x >= area.x &&
  point.x < area.x + area.width &&
  point.y >= area.y &&
  point.y < area.y + area.height

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

export const asViewport = (rect: Rect): Viewport => ({
  left: rect.x,
  top: rect.y,
  right: rect.x + rect.width,
  bottom: rect.y + rect.height
})

/**
 * The bounding box of the scanned text the popup is opening for.
 *
 * Yomitan passes one rectangle per line of the match, so a word wrapped across two
 * lines arrives as two, and it passes them as **edges** — `left`, `top`, `right`,
 * `bottom` — not as an origin and a size. That difference is not cosmetic: reading
 * `x` off one of these silently yields `undefined`, every rectangle looks unusable,
 * and the caller quietly behaves as though there were no anchor at all. Which is
 * exactly what happened: the popup opened on the first display instead of the one the
 * text was on.
 */
export function boundsOf(rects: Edges[]): Rect | null {
  const usable = rects.filter(
    (r) =>
      Number.isFinite(r.left) &&
      Number.isFinite(r.top) &&
      Number.isFinite(r.right) &&
      Number.isFinite(r.bottom)
  )
  if (usable.length === 0) return null
  const left = Math.min(...usable.map((r) => r.left))
  const top = Math.min(...usable.map((r) => r.top))
  const right = Math.max(...usable.map((r) => r.right))
  const bottom = Math.max(...usable.map((r) => r.bottom))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The bounding box of rectangles given as an origin and a size. */
export function boundingRect(rects: Rect[]): Rect | null {
  const usable = rects.filter(
    (r) => Number.isFinite(r.x) && Number.isFinite(r.y) && r.width >= 0 && r.height >= 0
  )
  if (usable.length === 0) return null
  return boundsOf(
    usable.map((r) => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height }))
  )
}

/**
 * Which display's work area the popup should be positioned within.
 *
 * The display the *text* is on, not the one the popup host happens to be sitting on
 * and not the one the OCR overlay is covering: the log window and the scanned source
 * can be on different monitors, and the popup belongs with the words.
 *
 * Chosen by the anchor's centre, falling back to the largest overlap for an anchor
 * that straddles a boundary, so a word half off the edge of a monitor still opens on
 * the monitor most of it is on. Desktop points are signed — a display above or to the
 * left of the primary has a negative origin — so nothing here may assume positive
 * coordinates.
 */
export function anchorViewport(
  anchors: Edges[],
  displays: DisplayArea[],
  fallback: Rect
): Viewport {
  const anchor = boundsOf(anchors)
  const areas = displays.map((display) => display.work_area).filter((area) => area.width > 0)
  if (areas.length === 0) return asViewport(fallback)
  if (!anchor) return asViewport(areas[0])

  const containing = areas.find((area) => contains(area, centre(anchor)))
  if (containing) return asViewport(containing)

  let best = areas[0]
  let bestOverlap = overlap(anchor, best)
  for (const area of areas.slice(1)) {
    const value = overlap(anchor, area)
    if (value > bestOverlap) {
      best = area
      bestOverlap = value
    }
  }
  return asViewport(best)
}

/**
 * The window that has to contain every popup currently on screen.
 *
 * One native window hosts the whole chain, because a nested lookup is a second
 * `Popup` in the same document and a window cannot be in two places. The window
 * becomes the bounding box of the visible chain and each frame is offset inside it,
 * which keeps every popup exactly where Yomitan put it on the desktop.
 */
export function chainWindow(rects: Rect[]): Rect | null {
  const box = boundingRect(rects.filter((r) => r.width > 0 && r.height > 0))
  return box && box.width > 0 && box.height > 0 ? box : null
}

/** Where a popup sits inside that window. */
export function insetIn(container: Rect, rect: Rect): { left: number; top: number } {
  return { left: rect.x - container.x, top: rect.y - container.y }
}

/** A rectangle as the edges Yomitan uses. */
export const asEdges = (rect: Rect): Edges => ({
  left: rect.x,
  top: rect.y,
  right: rect.x + rect.width,
  bottom: rect.y + rect.height
})

/** Whether a rectangle is entirely inside a viewport. */
export function fitsIn(rect: Rect, viewport: Viewport): boolean {
  return (
    rect.x >= viewport.left &&
    rect.y >= viewport.top &&
    rect.x + rect.width <= viewport.right &&
    rect.y + rect.height <= viewport.bottom
  )
}

/**
 * Drop source rectangles with no extent.
 *
 * `Range.getClientRects()` returns one rectangle per line box the range covers — and
 * for a range that begins exactly at a line boundary it also returns a **zero-width**
 * rectangle at the end of the *previous* line. That is a real position in the layout,
 * the caret position the range starts from, but it is not where the text is.
 *
 * Yomitan positions the popup by choosing among the source rectangles, and a
 * zero-width one at the end of the line above wins on room-below, so the popup opens
 * at the end of the previous line: one line up and as far right as that line went.
 * Which is exactly what the first word on every wrapped line looked like.
 *
 * A rectangle with no area cannot be where a word is, so it is not a candidate. If
 * they all have no area — a collapsed range — they are kept, because an anchor in the
 * wrong place still beats no anchor at all, which lands on the wrong display.
 */
export function withExtent(rects: Edges[]): Edges[] {
  const real = rects.filter((r) => r.right - r.left > 0 && r.bottom - r.top > 0)
  return real.length > 0 ? real : rects
}
