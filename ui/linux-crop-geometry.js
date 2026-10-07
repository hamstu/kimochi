/** Linux source-image crop coordinates are always full-frame capture pixels. */
/** @param {{x:number,y:number}} start @param {{x:number,y:number}} end @param {{width:number,height:number}} frame */
export function cropFromPoints(start, end, frame) {
  const clamp = (value, limit) => Math.max(0, Math.min(limit, value))
  const x = Math.floor(clamp(Math.min(start.x, end.x), frame.width))
  const y = Math.floor(clamp(Math.min(start.y, end.y), frame.height))
  const right = Math.ceil(clamp(Math.max(start.x, end.x), frame.width))
  const bottom = Math.ceil(clamp(Math.max(start.y, end.y), frame.height))
  if (![x, y, right, bottom].every(Number.isFinite) || right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y, reference_width: frame.width, reference_height: frame.height }
}

/** @param {{x:number,y:number,width:number,height:number,reference_width:number,reference_height:number}|null} crop @param {{width:number,height:number}} frame */
export function cropForFrame(crop, frame) {
  if (!crop || crop.reference_width <= 0 || crop.reference_height <= 0) return null
  const sx = frame.width / crop.reference_width
  const sy = frame.height / crop.reference_height
  return cropFromPoints({ x: crop.x * sx, y: crop.y * sy },
    { x: (crop.x + crop.width) * sx, y: (crop.y + crop.height) * sy }, frame)
}
