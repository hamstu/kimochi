/** Keep exact hooked text on the word boxes OCR measured, without reflowing a whole sentence. */
import type { Segment } from './ocr-result.js'
import type { Annotation } from './geometry.js'

const comparable = (character: string): string => character.normalize('NFKC').toLowerCase()

/**
 * Align characters with substitutions, insertions and deletions. Each corrected character stays
 * with its original OCR word; a character OCR omitted joins the adjacent word, never changing
 * the position of later words. All indices here count code points, not UTF-16 code units.
 */
export function remapHookSegments(hooked: string, segments: Segment[]): Segment[] {
  const valid = segments.filter(
    (segment) =>
      segment.text &&
      segment.bbox.length === 4 &&
      segment.bbox.every(Number.isFinite) &&
      segment.bbox[2] > segment.bbox[0] &&
      segment.bbox[3] > segment.bbox[1]
  )
  const source = valid.flatMap((segment, owner) => Array.from(segment.text, (character) => ({ character, owner })))
  const target = Array.from(hooked)
  const n = source.length
  const m = target.length
  if (!n || !m || n * m > 400000) return []
  const sourceChars = source.map(({ character }) => comparable(character))
  const targetChars = target.map(comparable)
  const width = m + 1
  const costs = new Uint32Array((n + 1) * width)
  for (let i = 0; i <= n; i++) costs[i * width] = i
  for (let j = 0; j <= m; j++) costs[j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const different = sourceChars[i - 1] !== targetChars[j - 1]
      costs[i * width + j] = Math.min(
        costs[(i - 1) * width + j - 1] + Number(different),
        costs[(i - 1) * width + j] + 1,
        costs[i * width + j - 1] + 1
      )
    }
  }
  const assignments: { owner: number; character: string }[] = []
  let i = n
  let j = m
  while (i || j) {
    const cost = costs[i * width + j]
    const different = i && j && sourceChars[i - 1] !== targetChars[j - 1]
    if (i && j && cost === costs[(i - 1) * width + j - 1] + Number(different)) {
      assignments.push({ owner: source[i - 1].owner, character: target[j - 1] })
      i--
      j--
    } else if (i && cost === costs[(i - 1) * width + j] + 1) i--
    else {
      assignments.push({ owner: source[Math.max(0, i - 1)].owner, character: target[j - 1] })
      j--
    }
  }
  const corrected = valid.map(() => '')
  for (const { owner, character } of assignments.reverse()) corrected[owner] += character
  return valid.flatMap((segment, index) =>
    corrected[index] ? [{ text: corrected[index], bbox: [...segment.bbox] as Segment['bbox'] }] : []
  )
}

/** Keep the renderer's aggregate-at-zero contract, including a separately positioned name. */
export function hookGeometryAnnotations(dialogue: Annotation[], names: Annotation[]): Annotation[] {
  const annotations = [...dialogue.map((annotation) => ({ ...annotation, anchorSegments: true })), ...names]
  if (annotations.length <= 1) return annotations
  return [
    {
      description: annotations.map((annotation) => annotation.description).join('\n'),
      granularity: 'aggregate',
      boundingPoly: annotations[0].boundingPoly
    },
    ...annotations
  ]
}
