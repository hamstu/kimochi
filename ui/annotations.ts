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

import { dropsText, type JapaneseFilter } from './japanese-text.js'

export interface Vertex {
  x?: number
  y?: number
}

/** The source's background around a box, top and bottom (`#rrggbb`), and the text that suits it. */
export interface Surface {
  top: string
  bottom: string
  ink: 'light' | 'dark'
}

export interface Annotation {
  description: string
  /** What the box sits on, read from the scanned frame (src-tauri/src/surface.rs), for Blend cards. */
  surface?: Surface
  orientation?: 'horizontal' | 'vertical'
  isVertical?: boolean
  groupId?: string
  granularity?: 'aggregate' | 'block' | 'line' | 'fragment'
  /** A speech bubble (Manga OCR's blocks): its own passage, never grouped with a neighbour. */
  bubble?: boolean
  boundingPoly: { vertices: Vertex[] }
  /** For a block: the lines found inside it, each a polygon of [x, y] points, in capture pixels. */
  linePolygons?: number[][][]
  /** For a block: per line, the words (or characters) on it with their boxes, when known. */
  lineSegments?: { text: string; bbox: number[] }[][]
  /** For a block: per line, its text, when the engine read each line on its own (Manga OCR). */
  lineTexts?: string[]
  /** For a line or word: its characters (or words) with their boxes, when known. */
  segments?: { text: string; bbox: number[] }[]
  /** How far outside the ink the engine draws boxes, in ems (see INK_MARGINS in ocr-result.ts). */
  inkMargin?: number[]
  /** The typeface the overlay sets this engine's text in (TYPEFACES in ocr-result.ts). */
  typeface?: string
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
  orientation?: 'horizontal' | 'vertical'
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
 * The furigana filter's strengths, as Settings offers them: each is a `threshold` for
 * `filterSmallTextAnnotations`, the share of the median text height below which text goes.
 */
export const FILTER_LEVELS = [
  {
    threshold: 0.5,
    label: 'Gentle',
    description:
      'Removes only text half the size of the main text or smaller, such as clear furigana above kanji. Small captions and names stay.'
  },
  {
    threshold: 0.6,
    label: 'Light',
    description:
      'Removes furigana and other text well under the main size. Most small print stays.'
  },
  {
    threshold: 0.75,
    label: 'Balanced',
    description:
      'Removes furigana and small labels under three-quarters of the main text size. Right for most text.'
  },
  {
    threshold: 0.85,
    label: 'Strong',
    description:
      'Also removes text a little smaller than the main text, such as speaker names and small menu text.'
  },
  {
    threshold: 0.95,
    label: 'Strict',
    description:
      'Keeps only text close to the size of the main text. Smaller lines you want to read can go too.'
  }
] as const

/** The step a stored threshold shows on: the nearest one. */
export function filterLevelOf(threshold: number): number {
  let best = 0
  FILTER_LEVELS.forEach((level, index) => {
    if (Math.abs(level.threshold - threshold) < Math.abs(FILTER_LEVELS[best].threshold - threshold))
      best = index
  })
  return best
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
  const medianHeight = median(boxed.map(({ annotation, box }) => annotation.isVertical ? box.width : box.height))
  const medianCharacterWidth = median(
    boxed.map(({ annotation, box }) => (annotation.isVertical ? box.height : box.width) / Math.max(1, [...annotation.description].length))
  )

  const minHeight = medianHeight * threshold
  const minWidth = medianCharacterWidth * 0.25
  const minWidthPerChar = medianCharacterWidth * 0.4

  return boxed
    .filter(({ annotation, box }) => {
      // 1: small text (furigana)
      if ((annotation.isVertical ? box.width : box.height) <= minHeight) return false
      // 2: very thin annotations (vertical line artifacts)
      if ((annotation.isVertical ? box.height : box.width) < minWidth) return false
      // 3: real text needs plausible width per character; several "characters"
      // crammed into a narrow box is OCR hallucinating from noise.
      const charCount = [...annotation.description].length
      if (charCount > 1 && (annotation.isVertical ? box.height : box.width) / charCount < minWidthPerChar) return false
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
  const medianHeight = median(boxed.map(({ annotation, box }) => annotation.isVertical ? box.width : box.height))
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

/** Set top to bottom: Live Text says so only by `orientation`, Google Lens also by `isVertical`. */
const isVertical = (a: Annotation): boolean => a.isVertical ?? a.orientation === 'vertical'

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

  // An engine's group always holds together, but only a speech bubble is kept apart from its
  // neighbours: Live Text calls every line a group and Google Lens every paragraph (both arrive
  // here as blocks, from normalizeOcrResult), and they cluster by proximity like any engine's lines.
  for (let i = 0; i < boxed.length; i++) {
    for (let j = i + 1; j < boxed.length; j++) {
      const a=boxed[i].annotation, b=boxed[j].annotation
      if (a.groupId && a.groupId===b.groupId) { union(i,j); continue }
      if (a.bubble || b.bubble) continue
      if (isVertical(a)!==isVertical(b)) continue
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
    const vertical=isVertical(groupAnnotations[0])
    const sortedAnnotations = [...groupAnnotations].sort((a, b) => {
      const aBox = getBoundingBox(a)
      const bBox = getBoundingBox(b)
      if (vertical) return Math.abs(aBox.centerX-bBox.centerX)<Math.min(aBox.width,bBox.width)*0.7 ? aBox.minY-bBox.minY : bBox.centerX-aBox.centerX
      const yDiff = aBox.minY - bBox.minY
      return Math.abs(yDiff) > 5 ? yDiff : aBox.minX - bBox.minX
    })

    let text = ''
    let lastCenterY = -1
    let lastMaxX = -1
    let lastBox: BoundingBox | null=null
    sortedAnnotations.forEach((annotation, index) => {
      const box = getBoundingBox(annotation)
      if (vertical && lastBox && Math.abs(lastBox.centerX-box.centerX)>Math.min(lastBox.width,box.width)*0.7) text+='\n'
      if (!vertical && index > 0 && lastCenterY !== -1) {
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
      lastBox=box
      lastCenterY = box.centerY
      lastMaxX = box.maxX
    })

    return {
      annotations: sortedAnnotations,
      orientation: vertical?'vertical':'horizontal',
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

/**
 * The filtered word annotations the overlay renders, honouring the settings: the small-text
 * filter, then "Japanese only" (`grouping` carries the Log's `cjkOnly` settings, see
 * `overlayGrouping` in overlay.js), judged per line or passage as the Log judges a line. Word
 * fragments are left alone: a Roman word inside a Japanese line is not a line of its own.
 */
export function visibleAnnotations(
  annotations: Annotation[],
  grouping: GroupingSettings & JapaneseFilter
): Annotation[] {
  return byLanguage(sizedAnnotations(wordAnnotations(annotations), grouping), grouping)
}

function sizedAnnotations(words: Annotation[], grouping: GroupingSettings): Annotation[] {
  if (!grouping.filterSmallText || words.length <= 1) return words
  if (words.some(a=>a.granularity==='block')) return words
  return filterSmallTextAnnotations(words, grouping.filterSmallTextThreshold)
}

function byLanguage(words: Annotation[], filter: JapaneseFilter): Annotation[] {
  if (!filter.japaneseOnly) return words
  return words.filter((a) => a.granularity === 'fragment' || !dropsText(a.description, filter))
}
