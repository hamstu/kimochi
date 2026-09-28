/**
 * Annotation filtering, ordering and grouping.
 *
 * Ported from the Electron app so the Tauri overlay produces identical text and
 * identical groups for the same OCR response:
 *   - src/renderer/src/utils/textAnnotationUtils.ts (filtering, buildFilteredText)
 *   - src/renderer/src/components/TextOverlay.tsx    (proximity grouping)
 *
 * Every function here works in **OCR pixel space** — the coordinate space of the
 * captured (post-crop) image, exactly as the endpoint reports it. Mapping to
 * desktop points happens afterwards in geometry.ts. This ordering matters:
 * `proximityThreshold` is an absolute pixel distance, so grouping has to run
 * before any scaling or the threshold would mean different things on 1x and
 * Retina captures.
 */

export interface Vertex {
  x?: number
  y?: number
}

export interface Annotation {
  description: string
  boundingPoly: { vertices: Vertex[] }
}

export interface BoundingBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
  centerX: number
  centerY: number
}

export interface TextGroup {
  annotations: Annotation[]
  boundingBox: BoundingBox
  text: string
}

export interface GroupingSettings {
  enabled: boolean
  proximityThreshold: number
  filterSmallText: boolean
  filterSmallTextThreshold: number
}

export const DEFAULT_GROUPING: GroupingSettings = {
  enabled: false,
  proximityThreshold: 100,
  filterSmallText: true,
  filterSmallTextThreshold: 0.75
}

/** The endpoint omits x/y entirely when the value is 0, so every read defaults. */
export function getBoundingBox(annotation: Annotation): BoundingBox {
  const vertices = annotation.boundingPoly.vertices
  const minX = Math.min(...vertices.map((v) => v.x ?? 0))
  const minY = Math.min(...vertices.map((v) => v.y ?? 0))
  const maxX = Math.max(...vertices.map((v) => v.x ?? 0))
  const maxY = Math.max(...vertices.map((v) => v.y ?? 0))
  const width = maxX - minX
  const height = maxY - minY
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: minX + width / 2,
    centerY: minY + height / 2
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Annotation 0 is the whole text block; word annotations start at index 1. */
export function wordAnnotations(annotations: Annotation[]): Annotation[] {
  return annotations.length > 1 ? annotations.slice(1) : annotations
}

/**
 * Drop furigana and OCR noise, relative to the medians of this capture.
 *
 * The character-width medians are per *character*, not per word: OCR splits text
 * into words of wildly different lengths, and a whole-word median throws away
 * long Japanese words. That correction lives in the Electron working tree and is
 * carried over here deliberately.
 */
export function filterSmallTextAnnotations(
  annotations: Annotation[],
  threshold: number
): Annotation[] {
  if (annotations.length <= 1) return annotations

  const boxed = annotations.map((annotation) => ({ annotation, box: getBoundingBox(annotation) }))
  const medianHeight = median(boxed.map((a) => a.box.height))
  const medianCharacterWidth = median(
    boxed.map(({ annotation, box }) => box.width / Math.max(1, [...annotation.description].length))
  )

  const minHeight = medianHeight * threshold
  const minWidth = medianCharacterWidth * 0.25
  const minWidthPerChar = medianCharacterWidth * 0.4

  return boxed
    .filter(({ annotation, box }) => {
      // 1: small text (furigana)
      if (box.height <= minHeight) return false
      // 2: very thin annotations (vertical line artifacts)
      if (box.width < minWidth) return false
      // 3: real text needs plausible width per character; several "characters"
      // crammed into a narrow box is OCR hallucinating from noise.
      const charCount = [...annotation.description].length
      if (charCount > 1 && box.width / charCount < minWidthPerChar) return false
      return true
    })
    .map(({ annotation }) => annotation)
}

/**
 * The reading-order string. This — not `ocr.fullText` — is what goes to the scan
 * history, the texthooker and TTS, so that all three agree with what the overlay
 * actually shows after filtering.
 */
export function buildFilteredText(
  annotations: Annotation[],
  filterEnabled: boolean,
  threshold: number
): string {
  if (annotations.length === 0) return ''

  const words = wordAnnotations(annotations)
  const filtered = filterEnabled ? filterSmallTextAnnotations(words, threshold) : words
  if (filtered.length === 0) return ''

  const boxed = filtered.map((annotation) => ({ annotation, box: getBoundingBox(annotation) }))
  const medianHeight = median(boxed.map((a) => a.box.height))
  const lineTolerance = medianHeight * 0.5
  const spaceThreshold = medianHeight * 1.5

  const sorted = [...boxed].sort((a, b) =>
    Math.abs(a.box.minY - b.box.minY) <= lineTolerance
      ? a.box.minX - b.box.minX
      : a.box.minY - b.box.minY
  )

  let result = ''
  let previous: BoundingBox | null = null
  for (const { annotation, box } of sorted) {
    if (previous !== null) {
      if (Math.abs(box.minY - previous.minY) > lineTolerance) result += '\n'
      else if (box.minX - previous.maxX > spaceThreshold) result += ' '
    }
    result += annotation.description
    previous = box
  }
  return result
}

/** Overlap counts as zero distance; otherwise the gap between closest edges. */
function areBoxesNearby(box1: BoundingBox, box2: BoundingBox, threshold: number): boolean {
  const horizontal = Math.max(0, Math.max(box1.minX, box2.minX) - Math.min(box1.maxX, box2.maxX))
  const vertical = Math.max(0, Math.max(box1.minY, box2.minY) - Math.min(box1.maxY, box2.maxY))
  return Math.sqrt(horizontal ** 2 + vertical ** 2) <= threshold
}

/** Union-find proximity clustering, so a paragraph becomes one readable card. */
export function groupTextAnnotations(
  annotations: Annotation[],
  proximityThreshold: number
): TextGroup[] {
  if (annotations.length === 0) return []

  const boxed = annotations.map((annotation) => ({ annotation, box: getBoundingBox(annotation) }))
  const parent = boxed.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (i: number, j: number): void => {
    const rootI = find(i)
    const rootJ = find(j)
    if (rootI !== rootJ) parent[rootJ] = rootI
  }

  for (let i = 0; i < boxed.length; i++) {
    for (let j = i + 1; j < boxed.length; j++) {
      if (areBoxesNearby(boxed[i].box, boxed[j].box, proximityThreshold)) union(i, j)
    }
  }

  const groups = new Map<number, Annotation[]>()
  boxed.forEach(({ annotation }, i) => {
    const root = find(i)
    const existing = groups.get(root)
    if (existing) existing.push(annotation)
    else groups.set(root, [annotation])
  })

  return [...groups.values()].map((groupAnnotations) => {
    const allVertices = groupAnnotations.flatMap((a) => a.boundingPoly.vertices)
    const minX = Math.min(...allVertices.map((v) => v.x ?? 0))
    const minY = Math.min(...allVertices.map((v) => v.y ?? 0))
    const maxX = Math.max(...allVertices.map((v) => v.x ?? 0))
    const maxY = Math.max(...allVertices.map((v) => v.y ?? 0))
    const width = maxX - minX
    const height = maxY - minY

    // Reading order within the group: 5px tolerance decides "same line".
    const sortedAnnotations = [...groupAnnotations].sort((a, b) => {
      const aBox = getBoundingBox(a)
      const bBox = getBoundingBox(b)
      const yDiff = aBox.minY - bBox.minY
      return Math.abs(yDiff) > 5 ? yDiff : aBox.minX - bBox.minX
    })

    let text = ''
    let lastCenterY = -1
    let lastMaxX = -1
    sortedAnnotations.forEach((annotation, index) => {
      const box = getBoundingBox(annotation)
      if (index > 0 && lastCenterY !== -1) {
        if (box.centerY - lastCenterY > box.height * 0.5) {
          text += '\n'
          lastMaxX = -1
        } else if (lastMaxX !== -1) {
          // A gap wider than ~1.5 characters is a word boundary, not kerning.
          const avgCharWidth = box.width / annotation.description.length
          if (box.minX - lastMaxX > avgCharWidth * 1.5) text += '　'
        }
      }
      text += annotation.description
      lastCenterY = box.centerY
      lastMaxX = box.maxX
    })

    return {
      annotations: sortedAnnotations,
      boundingBox: {
        minX,
        minY,
        maxX,
        maxY,
        width,
        height,
        centerX: minX + width / 2,
        centerY: minY + height / 2
      },
      text
    }
  })
}

/** The filtered word annotations the overlay renders, honouring the settings. */
export function visibleAnnotations(
  annotations: Annotation[],
  grouping: GroupingSettings
): Annotation[] {
  const words = wordAnnotations(annotations)
  if (!grouping.filterSmallText || words.length <= 1) return words
  return filterSmallTextAnnotations(words, grouping.filterSmallTextThreshold)
}
