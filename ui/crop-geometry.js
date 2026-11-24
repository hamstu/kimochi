/**
 * Region editor rectangles (overlay points) to saved crops (capture pixels), for any display scale.
 *
 * A window's bounds are in points and need not be whole: at 125% an 802-pixel-wide window is
 * 641.6 points wide, so its left edge can sit at 430.4 while the editor's box snaps to whole points
 * (430). Converting the box's origin and size separately then rounds it past the capture (x -0.4
 * points is pixel 0, but 642 points is 803 pixels against an 802-pixel capture), and native rejects
 * the crop as outside its reference image. Converting the two *edges* and clamping them to the
 * capture keeps every box drawn inside the window inside the image.
 */

/**
 * The crop, in pixels of a `reference` capture of `bounds`, for the editor's `rect`.
 *
 * `rect` and `origin` are overlay points (`rect` relative to the overlay at `origin`), `bounds` is
 * the source in the same points, and `scale` is capture pixels per point. `reference` is the
 * capture's own size once known; until then `bounds` × `scale`. Null when nothing of the box is
 * left inside the capture.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{x:number,y:number}} origin
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {number} scale
 * @param {{width:number,height:number}|null} [reference]
 */
export function cropFor(rect, origin, bounds, scale, reference = null) {
  const referenceWidth = reference?.width > 0 ? reference.width : Math.round(bounds.width * scale)
  const referenceHeight = reference?.height > 0 ? reference.height : Math.round(bounds.height * scale)
  const edge = (point, limit) => Math.min(limit, Math.max(0, Math.round(point * scale)))
  const left = rect.x + origin.x - bounds.x
  const top = rect.y + origin.y - bounds.y
  const x = edge(left, referenceWidth)
  const y = edge(top, referenceHeight)
  const right = edge(left + rect.width, referenceWidth)
  const bottom = edge(top + rect.height, referenceHeight)
  if (![x, y, right, bottom].every(Number.isFinite) || right <= x || bottom <= y) return null
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
    reference_width: referenceWidth,
    reference_height: referenceHeight
  }
}
