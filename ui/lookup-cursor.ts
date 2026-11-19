import { lookupModifier } from './lookup-key.js'
import type { PointerSample } from './scan-input.js'

type LookupCursorSample = Pick<PointerSample, 'over' | 'blocked' | 'shift' | 'ctrl' | 'alt' | 'meta'>

export function lookupCursorPoint(
  sample: LookupCursorSample,
  local: { x: number; y: number } | null,
  key: unknown,
  enabled: boolean
): { x: number; y: number } | null {
  if (!enabled || !sample[lookupModifier(key)] || sample.over === false || sample.blocked || !local) return null
  return Number.isFinite(local.x) && Number.isFinite(local.y) ? local : null
}

export function updateLookupCursor(
  element: SVGElement | null,
  sample: LookupCursorSample,
  local: { x: number; y: number } | null,
  key: unknown,
  enabled: boolean
): void {
  if (!element) return
  const point = lookupCursorPoint(sample, local, key, enabled)
  element.style.display = point ? 'block' : 'none'
  // Avoid doubling the WebView2 cursor when the pointer crosses scanned text.
  element.ownerDocument.documentElement.classList.toggle('lookup-cursor-visible', Boolean(point))
  if (point) element.style.transform = `translate(${point.x}px, ${point.y}px)`
}
