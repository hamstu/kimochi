export interface Crop {
  x: number
  y: number
  width: number
  height: number
  reference_width: number
  reference_height: number
}
export interface Point {
  x: number
  y: number
}

/** Preview DOM points map to full source pixels, independent of the panel's DPR. */
export function cropFromDrag(start: Point, end: Point, width: number, height: number): Crop | null {
  if (
    ![start.x, start.y, end.x, end.y, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    return null
  const clamp = (n: number, max: number): number => Math.max(0, Math.min(max, n))
  const x = Math.floor(clamp(Math.min(start.x, end.x), width))
  const y = Math.floor(clamp(Math.min(start.y, end.y), height))
  const right = Math.ceil(clamp(Math.max(start.x, end.x), width))
  const bottom = Math.ceil(clamp(Math.max(start.y, end.y), height))
  if (right <= x || bottom <= y) return null
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
    reference_width: width,
    reference_height: height
  }
}

export function scaleCrop(crop: Crop, width: number, height: number): Crop | null {
  if (crop.reference_width <= 0 || crop.reference_height <= 0) return null
  return cropFromDrag(
    { x: (crop.x * width) / crop.reference_width, y: (crop.y * height) / crop.reference_height },
    {
      x: ((crop.x + crop.width) * width) / crop.reference_width,
      y: ((crop.y + crop.height) * height) / crop.reference_height
    },
    width,
    height
  )
}
