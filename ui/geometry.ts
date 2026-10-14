/**
 * Coordinates. Every rectangle and point native hands a page is in *desktop points*:
 * the OS desktop in units of one CSS pixel on the display they are on. On macOS those
 * are the OS's own points; on Windows native converts physical pixels per monitor
 * before anything reaches a page (see `platform::DesktopGeometry`). Frame pixels
 * (`full_*`, `crop_pixels`, OCR vertices) are capture pixels and never desktop points.
 */
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
  /** For a block: the lines found inside it, as polygons of [x, y] points in capture pixels. */
  linePolygons?: number[][][]
  /** For a block: per line, its words (or characters) with their boxes, `[x1, y1, x2, y2]`. */
  lineSegments?: { text: string; bbox: number[] }[][]
  /** For a line or word: its characters (or words) with their boxes. */
  segments?: { text: string; bbox: number[] }[]
  /** How far outside the ink the engine draws boxes, in ems (INK_MARGINS in ocr-result.ts). */
  inkMargin?: number[]
  /** The typeface the overlay sets this engine's text in (TYPEFACES in ocr-result.ts). */
  typeface?: string
  groupId?: string
  boundingPoly: { vertices: { x?: number; y?: number }[] }
}
/** A word or character of a line, mapped like everything else. */
export type MappedSegment = Rect & { text: string }
/** An annotation mapped to overlay-local points, with what the layout needs of it. */
export type MappedBox = Rect & {
  text: string
  orientation?: 'horizontal' | 'vertical'
  isVertical?: boolean
  granularity?: string
  groupId?: string
  lines?: Rect[]
  lineSegments?: MappedSegment[][]
  segments?: MappedSegment[]
  inkMargin?: number[]
  typeface?: string
}
/**
 * Current full capture pixels → desktop points, per axis.
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
 * when the same window moves between a 1× and a Retina (or 150 %) display.
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
): MappedBox[] {
  const finite = (r: Rect): boolean =>
    [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0
  const segment = (s: { text: string; bbox: number[] }): MappedSegment[] => {
    const [x1, y1, x2, y2] = s.bbox
    const r = mapRect(info, origin, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, bounds)
    return typeof s.text === 'string' && finite(r) ? [{ ...r, text: s.text }] : []
  }
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
    // The lines found inside a block, mapped the same way, for placing its characters, with the
    // words found on each (kept beside their line, so they stay paired when a line is dropped).
    const placed = (a.linePolygons ?? [])
      .map((polygon, index) => {
        const px = polygon.map((point) => point[0])
        const py = polygon.map((point) => point[1])
        const x = Math.min(...px)
        const y = Math.min(...py)
        const line = mapRect(info, origin, { x, y, width: Math.max(...px) - x, height: Math.max(...py) - y }, bounds)
        return { line, words: (a.lineSegments?.[index] ?? []).flatMap(segment) }
      })
      .filter(({ line }) => finite(line))
    const lines = placed.map(({ line }) => line)
    const lineSegments = placed.map(({ words }) => words)
    const segments = (a.segments ?? []).flatMap(segment)
    return [
      {
        ...mapped,
        text: a.description,
        ...(a.orientation !== undefined ? { orientation: a.orientation } : {}),
        ...(a.isVertical !== undefined ? { isVertical: a.isVertical } : {}),
        ...(a.granularity !== undefined ? { granularity: a.granularity } : {}),
        ...(a.groupId !== undefined ? { groupId: a.groupId } : {}),
        ...(lines.length ? { lines } : {}),
        ...(lineSegments.some((words) => words.length) ? { lineSegments } : {}),
        ...(segments.length ? { segments } : {}),
        ...(a.inkMargin?.length === 4 ? { inkMargin: a.inkMargin } : {}),
        ...(a.typeface ? { typeface: a.typeface } : {})
      }
    ]
  })
}
/** Convenience wrapper that drops the full-text annotation at index 0. */
export function boxes(
  info: FrameInfo,
  annotations: Annotation[],
  origin: Rect,
  bounds?: Rect
): MappedBox[] {
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
 * Both spaces are desktop points, so this is a translation and never a scale: the
 * overlay covers `origin` exactly, and its viewport is that many CSS pixels wide
 * whatever the display's backing (macOS) or DPI (Windows) scale. A display left of or above the primary has a
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
