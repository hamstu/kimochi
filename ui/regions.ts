/**
 * Turning the dictionary popup into a rectangle the overlay can defend.
 *
 * The overlay window ignores the mouse everywhere except the rectangles it
 * publishes to Rust, and a press outside those rectangles is what native counts as
 * a click away from the dictionary. The popup therefore has to appear in that list
 * or it is doubly unusable: its clicks and scrolls go to the application behind the
 * overlay, and the same press dismisses it.
 *
 * It cannot be found from the DOM. `Popup._setUpContainer` puts the frame inside a
 * shadow root opened with `mode: 'closed'` whenever `general.usePopupShadowDom` is
 * set, which it is by default, and hangs it off an unmarked `div` whose style is
 * `all: initial`. Nothing selectable identifies either. What is public is the popup
 * object: `isVisibleSync()`, `getFrameRect()` and `child` are all documented API on
 * `Popup`, and walking them is exactly what `Popup.containsPoint` does internally.
 */

/** The part of the original `Popup` interface this needs. Structural on purpose. */
export interface PopupLike {
  isVisibleSync(): boolean
  getFrameRect(): { left: number; top: number; right: number; bottom: number; valid: boolean }
  readonly child: PopupLike | null
}

export interface Origin {
  x: number
  y: number
}

export interface HitRect {
  x: number
  y: number
  width: number
  height: number
  focus: boolean
}

/**
 * Desktop rectangles for every visible popup and nested child popup.
 *
 * A hidden popup keeps its container, its last position and its last size, so
 * visibility is checked at each link rather than once at the root — a nested lookup
 * that has been closed must not leave a hole in the desktop that swallows clicks.
 * A chain stops at the first hidden link for the same reason `containsPoint` does:
 * a child is only on screen while its parent is.
 *
 * `valid` is false for popups whose frame lives in another realm (`PopupProxy`,
 * `PopupWindow`). Their rectangle belongs to the window that actually owns the
 * frame, and inventing one here would defend the wrong pixels.
 */
export function popupHitRects(popups: Iterable<PopupLike>, origin: Origin | null): HitRect[] {
  if (!origin) return []
  const rects: HitRect[] = []
  for (const root of popups) {
    for (
      let popup: PopupLike | null = root;
      popup !== null && popup.isVisibleSync();
      popup = popup.child
    ) {
      const { left, top, right, bottom, valid } = popup.getFrameRect()
      if (!valid) continue
      const width = right - left
      const height = bottom - top
      if (!(width > 0) || !(height > 0)) continue
      if (![left, top, width, height].every(Number.isFinite)) continue
      rects.push({ x: origin.x + left, y: origin.y + top, width, height, focus: true })
    }
  }
  return rects
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * `area` less every rectangle in `holes`, as rectangles that do not overlap.
 *
 * GNOME: while the dictionary popup is open, the overlay takes the next click anywhere so that
 * clicking away closes the popup without the click reaching the game. Yomitan's popup there is a
 * window of its own, which the overlay may be stacked above, so the overlay takes everything
 * except the popup's own rectangles, or it would take the popup's clicks too.
 */
export function exceptRects(area: Rect, holes: Iterable<Rect>): Rect[] {
  let pieces: Rect[] = area.width > 0 && area.height > 0 ? [{ ...area }] : []
  for (const hole of holes) {
    if (!(hole.width > 0 && hole.height > 0)) continue
    const next: Rect[] = []
    for (const p of pieces) {
      const left = Math.max(p.x, hole.x)
      const top = Math.max(p.y, hole.y)
      const right = Math.min(p.x + p.width, hole.x + hole.width)
      const bottom = Math.min(p.y + p.height, hole.y + hole.height)
      if (left >= right || top >= bottom) {
        next.push(p)
        continue
      }
      // Above and below the hole across the whole piece, then beside it within its rows.
      if (top > p.y) next.push({ x: p.x, y: p.y, width: p.width, height: top - p.y })
      if (bottom < p.y + p.height) next.push({ x: p.x, y: bottom, width: p.width, height: p.y + p.height - bottom })
      if (left > p.x) next.push({ x: p.x, y: top, width: left - p.x, height: bottom - top })
      if (right < p.x + p.width) next.push({ x: right, y: top, width: p.x + p.width - right, height: bottom - top })
    }
    pieces = next
  }
  return pieces
}
