/** Keep only independently verified lines; never fuzzy-match their text. */
import { identityKey, boxesOverlap, type ObservedLine, type TextBox } from './observation.js'
import type { Annotation } from './annotations.js'

export function currentLines(
  before: ObservedLine[] | null,
  now: ObservedLine[] | null,
  tolerance: number
): ObservedLine[] {
  return (before ?? []).filter(
    (line) =>
      identityKey(line.text) !== '' &&
      (now ?? []).some(
        (next) =>
          identityKey(line.text) === identityKey(next.text) &&
          boxesOverlap(line.box, next.box, tolerance)
      )
  )
}

/** All vertices must belong to one surviving line. A whole-page aggregate cannot pass. */
export function annotationsInLines(
  annotations: unknown[],
  boxes: TextBox[],
  tolerance = 3
): Annotation[] {
  const words = (annotations.length > 1 ? annotations.slice(1) : annotations).filter(
    (value): value is Annotation => {
      if (!value || typeof value !== 'object') return false
      const a = value as Partial<Annotation>
      const vertices = a.boundingPoly?.vertices
      if (typeof a.description !== 'string' || !vertices || vertices.length < 4) return false
      return boxes.some((box) =>
        vertices.every((vertex) => {
          const x = vertex.x ?? 0,
            y = vertex.y ?? 0
          return (
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            x >= box.x - tolerance &&
            x <= box.x + box.width + tolerance &&
            y >= box.y - tolerance &&
            y <= box.y + box.height + tolerance
          )
        })
      )
    }
  )
  if (words.length < 2) return words
  const vertices = words.flatMap((word) => word.boundingPoly.vertices)
  const minX = Math.min(...vertices.map((v) => v.x ?? 0)),
    minY = Math.min(...vertices.map((v) => v.y ?? 0))
  const maxX = Math.max(...vertices.map((v) => v.x ?? 0)),
    maxY = Math.max(...vertices.map((v) => v.y ?? 0))
  return [
    {
      description: words.map((word) => word.description).join(' '),
      boundingPoly: {
        vertices: [
          { x: minX, y: minY },
          { x: maxX, y: minY },
          { x: maxX, y: maxY },
          { x: minX, y: maxY }
        ]
      }
    },
    ...words
  ]
}

/** A nonblank first-pass miss needs confirmation; one noisy reading is not disappearance. */
export function confirmedCurrentLines(
  before: ObservedLine[] | null,
  now: ObservedLine[] | null,
  tolerance: number,
  misses: Map<ObservedLine, number>
): ObservedLine[] {
  const verified = new Set(currentLines(before, now, tolerance))
  return (before ?? []).filter((line) => {
    if (verified.has(line)) {
      misses.delete(line)
      return true
    }
    const count = (misses.get(line) ?? 0) + 1
    if (count >= 2) {
      misses.delete(line)
      return false
    }
    misses.set(line, count)
    return true
  })
}
