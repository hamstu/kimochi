/** Only compositor-linked, current-size portal frames can overlay a window.
 * A window move is safe; a resized window must wait for a new matching buffer.
 * Unknown geometry keeps the source-image crop fallback and no desktop annotations.
 */
export function portalWindowBounds(info, liveBounds = null) {
  if (!info?.source_id?.startsWith('portal:window:') || !info.source_bounds) return null
  const bounds = liveBounds ?? info.source_bounds
  const scale = info.scale_factor
  if (![bounds.x, bounds.y, bounds.width, bounds.height, scale].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || scale <= 0) return null
  if (Math.abs(bounds.width * scale - info.full_width) > 2
    || Math.abs(bounds.height * scale - info.full_height) > 2) return null
  return bounds
}

/** A mapped window is edited in-place, limited to its visible part on this output. */
export function portalCropArea(bounds, viewport) {
  const x = Math.max(0, bounds.x)
  const y = Math.max(0, bounds.y)
  const right = Math.min(viewport.width, bounds.x + bounds.width)
  const bottom = Math.min(viewport.height, bounds.y + bounds.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}
