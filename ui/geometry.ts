export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface FrameInfo {
  full_width: number
  full_height: number
  crop_pixels: number[]
  source_bounds: Rect
}
export interface Annotation {
  description: string
  isVertical?: boolean
  orientation?: 'horizontal' | 'vertical'
  granularity?: string
  groupId?: string
  boundingPoly: { vertices: { x?: number; y?: number }[] }
}
/**
 * Current full capture pixels → logical desktop points, per axis.
 *
 * `bounds` is where the source is *now*. It defaults to where it was when the
 * frame was captured, which is the only thing a frame knows about itself. A
 * caller tracking the source live passes the live bounds instead, so text drawn
 * from an older capture stays over the words it describes when the window moves
 * or is resized.
 */
export function scaleOf(info: FrameInfo, bounds?: Rect): { sx: number; sy: number } {
  if (info.full_width <= 0 || info.full_height <= 0) throw Error('Invalid full capture dimensions')
  const b = bounds ?? info.source_bounds
  return { sx: b.width / info.full_width, sy: b.height / info.full_height }
}
/**
 * Map a rectangle in OCR pixel space to overlay-local points.
 *
 * Reference-crop rescaling belongs to capture-core: `crop_pixels` already
 * describes the crop in the *current* capture's pixels, so each axis only needs
 * its own current-full-to-logical ratio. That is what keeps a saved crop correct
 * when the same window moves between a 1× and a Retina display.
 *
 * Pixels and points stay independent: everything the frame knows — the crop
 * offset, the annotation rectangle, the full dimensions — remains in the capture
 * pixel space it was measured in, and only `bounds` carries where that capture
 * currently sits on the desktop. Moving a window therefore changes the origin
 * and nothing else; a display with a different backing scale changes neither,
 * because points are points on both.
 */
export function mapRect(info: FrameInfo, origin: Rect, rect: Rect, bounds?: Rect): Rect {
  const { sx, sy } = scaleOf(info, bounds)
  const b = bounds ?? info.source_bounds
  return {
    x: b.x - origin.x + (info.crop_pixels[0] + rect.x) * sx,
    y: b.y - origin.y + (info.crop_pixels[1] + rect.y) * sy,
    width: rect.width * sx,
    height: rect.height * sy
  }
}
/** Map already-selected annotations; the caller owns filtering and ordering. */
export function mapAnnotations(
  info: FrameInfo,
  annotations: Annotation[],
  origin: Rect,
  bounds?: Rect
): (Rect & { text: string; orientation?: 'horizontal' | 'vertical'; isVertical?: boolean; granularity?: string; groupId?: string })[] {
  return annotations.flatMap((a) => {
    const vertices = a.boundingPoly?.vertices
    if (!vertices?.length || !a.description) return []
    const xs = vertices.map((v) => v.x ?? 0),
      ys = vertices.map((v) => v.y ?? 0)
    const left = Math.min(...xs),
      top = Math.min(...ys)
    const mapped = mapRect(
      info,
      origin,
      { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top },
      bounds
    )
    if (
      ![mapped.x, mapped.y, mapped.width, mapped.height].every(Number.isFinite) ||
      mapped.width <= 0 ||
      mapped.height <= 0
    )
      return []
    return [{ ...mapped, text: a.description, ...(a.orientation !== undefined ? { orientation: a.orientation } : {}), ...(a.isVertical !== undefined ? { isVertical: a.isVertical } : {}), ...(a.granularity !== undefined ? { granularity: a.granularity } : {}), ...(a.groupId !== undefined ? { groupId: a.groupId } : {}) }]
  })
}
/** Convenience wrapper that drops the full-text annotation at index 0. */
export function boxes(
  info: FrameInfo,
  annotations: Annotation[],
  origin: Rect,
  bounds?: Rect
): (Rect & { text: string; orientation?: 'horizontal' | 'vertical'; isVertical?: boolean; granularity?: string; groupId?: string })[] {
  return mapAnnotations(
    info,
    annotations.length > 1 ? annotations.slice(1) : annotations,
    origin,
    bounds
  )
}
export function sourceDisplay(source: Rect, displays: Rect[]): Rect {
  const x = source.x + source.width / 2,
    y = source.y + source.height / 2
  const found = displays.find(
    (d) => x >= d.x && y >= d.y && x < d.x + d.width && y < d.y + d.height
  )
  if (!found) throw Error('Source center is outside connected displays')
  return found
}

/**
 * A desktop point in the overlay window's own coordinates.
 *
 * Both spaces are macOS points, so this is a translation and never a scale: the
 * overlay covers `origin` exactly, and its viewport is that many CSS pixels wide
 * whatever the display's backing scale. A display left of or above the primary has a
 * negative origin, which is why this must subtract rather than assume a first
 * quadrant.
 */
export function toOverlayLocal(
  point: { x: number; y: number },
  origin: { x: number; y: number } | null
): { x: number; y: number } | null {
  if (!origin) return null
  return { x: point.x - origin.x, y: point.y - origin.y }
}
