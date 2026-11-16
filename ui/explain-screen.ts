/**
 * Explain on the overlay: what is explained and how it is asked for. The text on screen is the
 * sentence (the scan's groups, or the Text Hooker's line), and the Log's newest lines before it are
 * the scene it is read in, as the Log's own Explain gives them (the Log logs a scan a line per
 * group, so the screen's own lines are told apart from the scene by their text). The prompt is the
 * Log's, from the same stored settings (`superTexthooker`), so Explain reads the same wherever it
 * is asked for.
 */
import { explainPromptFor } from './explain-prompt.js'
import { explainSettings } from './explain-settings.js'
import { sectionText } from './log-sections.js'

/** How many earlier lines go with the text as its scene, as in the Log (texthooker/lib/explain.ts). */
export const CONTEXT_LINES = 15

/** A line as `log_recent` gives it, newest first. */
export interface RecentLine {
  text?: unknown
  /** Where the line came from (`ocr`, `hook`, …): one read with OCR has its wraps taken out. */
  source?: unknown
}

export interface ExplainRequest {
  /** The text explained: the screen's sections, one per line. */
  sentence: string
  /** The earlier lines, oldest first, or the Log's placeholder when there are none. */
  context: string
  /** The word the reader highlighted, explained first; null for the whole text. */
  word: string | null
  /** Where in `sentence` the word is (its first character), or null when not found or none. */
  at: number | null
  /** Whether the sentence was read with OCR (not hooked from the game): its wraps are taken out. */
  ocr: boolean
  prompt: string
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the answer goes, in overlay coordinates: the side of the text it is on, and either `top`
 * or `bottom` (from the overlay's bottom: a card over the text grows upwards, away from it).
 */
export interface Placement {
  side: 'below' | 'above' | 'right' | 'left'
  left: number
  width: number
  top: number | null
  bottom: number | null
  maxHeight: number
  /** Where the notch points along the card's edge facing the text: from its left (below, above) or top. */
  caret: number
}

/**
 * The drawn text an explanation is about, as one box: the boxes around `seed` that touch it or each
 * other, one line's height apart at most (the lines of a dialogue box, the columns of a bubble).
 * Boxes elsewhere on screen are left out even when their text is in what is explained: a scan
 * draws many short boxes (a particle, a "！"), and the same text turns up across the screen.
 * `seed` is the box the highlighted word is in, or, with none, the one with the most text.
 */
export function clusterBoxes(boxes: readonly Box[], seed: number): Box | null {
  const first = boxes[seed]
  if (!first) return null
  const gap = Math.max(12, Math.min(first.width, first.height))
  return growFrom(boxes, seed, (union, box) => {
    const { dx, dy } = apart(union, box)
    return dx <= gap && dy <= gap
  })
}

/** How far apart two boxes are across (`dx`) and down (`dy`); 0 where they overlap. */
function apart(a: Box, b: Box): { dx: number; dy: number } {
  return {
    dx: Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)),
    dy: Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height))
  }
}

/**
 * The box `seed` is, grown by every box that `joins` what has been taken so far (taken again
 * as it grows, so a chain of near boxes is all taken), as one box.
 */
function growFrom(boxes: readonly Box[], seed: number, joins: (union: Box, box: Box) => boolean): Box | null {
  const first = boxes[seed]
  if (!first) return null
  const taken = new Set([seed])
  let union = { ...first }
  for (let grew = true; grew;) {
    grew = false
    boxes.forEach((box, index) => {
      if (taken.has(index) || !joins(union, box)) return
      taken.add(index)
      const right = Math.max(union.x + union.width, box.x + box.width)
      const bottom = Math.max(union.y + union.height, box.y + box.height)
      const x = Math.min(union.x, box.x)
      const y = Math.min(union.y, box.y)
      union = { x, y, width: right - x, height: bottom - y }
      grew = true
    })
  }
  return union
}

/**
 * The line of horizontal text `seed` is on, as one box: the boxes level with it (their middles
 * within most of a line's height) that run on from it along the line, a word gap or so apart.
 * Where a word is asked about, the card goes by its line rather than by its whole paragraph, which
 * on a page of text (a browser, a document) can fill the screen and leave no room above or below.
 */
export function lineBoxes(boxes: readonly Box[], seed: number): Box | null {
  const first = boxes[seed]
  if (!first) return null
  const middle = (box: Box): number => box.y + box.height / 2
  const em = (box: Box): number => Math.max(1, Math.min(box.height, first.height))
  // Level with the seed (not with what has been taken), and a word gap or so along from the line.
  return growFrom(
    boxes,
    seed,
    (union, box) => Math.abs(middle(box) - middle(first)) < em(box) * 0.7 && apart(union, box).dx < em(box) * 1.8
  )
}

/**
 * The word in `text` at a caret `offset` (where the pointer is), as `{start, end}`; null when it
 * is not on a word (a space, punctuation). Words are the language's own (`Intl.Segmenter`), so a
 * line OCR read as one box gives the word pointed at, in Japanese as in Spanish. A caret just past
 * a word's last letter (the pointer on its right half) is still on it.
 */
export function wordSpanAt(text: string, offset: number, language?: string): { start: number; end: number } | null {
  if (!text) return null
  let segmenter: Intl.Segmenter
  try {
    segmenter = new Intl.Segmenter(language || undefined, { granularity: 'word' })
  } catch {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
  }
  const segments = segmenter.segment(text)
  for (const at of [offset, offset - 1]) {
    if (at < 0 || at >= text.length) continue
    const segment = segments.containing(at)
    if (segment?.isWordLike) return { start: segment.index, end: segment.index + segment.segment.length }
  }
  return null
}

/** The box a point (a highlighted word's middle) is in, or the nearest one; -1 with none. */
export function boxAt(boxes: readonly Box[], x: number, y: number): number {
  let best = -1
  let nearest = Infinity
  boxes.forEach((box, index) => {
    const dx = Math.max(0, box.x - x, x - (box.x + box.width))
    const dy = Math.max(0, box.y - y, y - (box.y + box.height))
    const distance = Math.hypot(dx, dy)
    if (distance < nearest) {
      nearest = distance
      best = index
    }
  })
  return best
}

/** How far the card stands off the text and keeps from the overlay's edges. */
const GAP = 10
const MARGIN = 8
/** The room a card needs under or over the text to go there, and beside it (vertical text). */
const ROOM = 180
const SIDE_ROOM = 320
/** The least a card is given where it has to cover text (nowhere else to go). */
const CRAMPED = 240
const MAX_HEIGHT = 480
/** The card's width under or over the text, whatever the text's own (the overlay's, if narrower). */
const WIDTH = 640

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))

/**
 * The card right under the text it explains (`anchor`, overlay coordinates), or over it where
 * there is not room enough below, at its own width (`WIDTH`) centred on the text, its notch on the highlighted
 * word (`focus`) or the text's middle. Where neither has room (vertical text filling a page), beside
 * it; where nothing has, on the side with the most room, over some of the text. Without an anchor,
 * over the top of `area` (the source), with no notch to point.
 */
export function placeExplanation(
  anchor: Box | null,
  focus: Box | null,
  area: Box | null,
  viewport: { width: number; height: number }
): Placement {
  const { width: vw, height: vh } = viewport
  if (!anchor) {
    const width = Math.round(Math.min(WIDTH, vw - 2 * MARGIN))
    const x = area ? area.x + (area.width - width) / 2 : (vw - width) / 2
    const top = Math.round(clamp((area?.y ?? 0) + MARGIN, MARGIN, vh - MARGIN - CRAMPED))
    return {
      side: 'below',
      left: Math.round(clamp(x, MARGIN, vw - width - MARGIN)),
      width,
      top,
      bottom: null,
      maxHeight: Math.min(MAX_HEIGHT, vh - MARGIN - top),
      caret: Math.round(width / 2)
    }
  }
  const point = {
    x: focus ? focus.x + focus.width / 2 : anchor.x + anchor.width / 2,
    y: focus ? focus.y + focus.height / 2 : anchor.y + anchor.height / 2
  }
  // Over the text, clear of the readings OCR leaves out of its boxes (furigana stand over a line,
  // about half its height).
  const over = GAP + Math.min(24, Math.round(anchor.height * 0.25))
  const below = vh - MARGIN - (anchor.y + anchor.height + GAP)
  const above = anchor.y - over - MARGIN
  const right = vw - MARGIN - (anchor.x + anchor.width + GAP)
  const left = anchor.x - GAP - MARGIN

  if (below < ROOM && above < ROOM && Math.max(right, left) >= SIDE_ROOM) {
    const side = right >= SIDE_ROOM ? 'right' : 'left'
    const width = Math.round(Math.min(420, side === 'right' ? right : left))
    // Its top a little over the word, so the notch is always on the card, however short it is.
    const top = Math.round(clamp(point.y - 40, MARGIN, vh - MARGIN - CRAMPED))
    return {
      side,
      left: Math.round(side === 'right' ? anchor.x + anchor.width + GAP : anchor.x - GAP - width),
      width,
      top,
      bottom: null,
      maxHeight: Math.min(MAX_HEIGHT, vh - MARGIN - top),
      caret: Math.round(clamp(point.y - top, 18, CRAMPED - 18))
    }
  }

  const width = Math.round(Math.min(WIDTH, vw - 2 * MARGIN))
  const x = Math.round(clamp(anchor.x + anchor.width / 2 - width / 2, MARGIN, vw - width - MARGIN))
  const caret = Math.round(clamp(point.x - x, 18, width - 18))
  const side = below >= ROOM || (above < ROOM && below >= above) ? 'below' : 'above'
  const maxHeight = Math.round(Math.min(MAX_HEIGHT, Math.max(CRAMPED, side === 'below' ? below : above)))
  if (side === 'below') {
    const top = Math.round(clamp(anchor.y + anchor.height + GAP, MARGIN, vh - MARGIN - Math.min(maxHeight, CRAMPED)))
    return { side, left: x, width, top, bottom: null, maxHeight: Math.min(maxHeight, vh - MARGIN - top), caret }
  }
  const bottom = Math.round(clamp(vh - (anchor.y - over), MARGIN, vh - MARGIN - Math.min(maxHeight, CRAMPED)))
  return { side, left: x, width, top: null, bottom, maxHeight: Math.min(maxHeight, vh - MARGIN - bottom), caret }
}

const clean = (text: unknown): string => (typeof text === 'string' ? text.trim() : '')

/** The marks around the highlighted word in the sentence the AI is given (`DEFAULT_FOCUS_PROMPT` names them). */
export const MARK_OPEN = '<TO EXPLAIN>'
export const MARK_CLOSE = '</TO EXPLAIN>'

/**
 * The default instruction for a highlighted word (Explain settings → Prompt for a highlighted
 * word): `{{word}}` is the word. It is marked in the sentence where it was found there (`markWord`),
 * and the instruction says so in words of its own, so a reader's own instruction can say it or not.
 */
export const DEFAULT_FOCUS_PROMPT = `FOCUS: The reader highlighted "{{word}}" in the target sentence. Where it was found there, it is marked as ${MARK_OPEN}{{word}}${MARK_CLOSE}; the marks are not part of the text, so never repeat them. The answer is about that word first, so use this structure instead of the one asked for above:
1. Open with a paragraph of two to four sentences about the highlighted word alone: what it means here, and if it is a grammar point (a particle, conjugation, auxiliary, sentence ending or construction), how that grammar works and what it adds in this sentence. If the highlight cuts a word or construction in two, explain the whole of it. The reader already sees the word above your answer, so give this paragraph no heading and do not open by repeating the word.
2. Then a natural English translation of the whole sentence on one line, labelled so the reader knows what it is, as in: **Translation:** …
3. Then the rest of the sentence as a short list of at most three points, one line each. Do not explain the highlighted word again there.`

/**
 * What goes after the prompt when the reader highlighted a word: start with that word, or the
 * grammar it is part of, as it is used here. After the template rather than in it, so a prompt of
 * the reader's own gets it too. `stored` is the reader's own instruction (empty: the default).
 */
export function focusInstruction(word: string, stored?: unknown): string {
  const template = typeof stored === 'string' && stored.trim() ? stored : DEFAULT_FOCUS_PROMPT
  return template.split('{{word}}').join(word)
}

/** A highlighted word, with the text just before and after it where it is drawn. */
export interface Focus {
  text: string
  /** What comes before it in its box (or on its card). */
  before?: string
  /** What comes after it: the rest of its box and the lookahead (the next words). */
  after?: string
}

const squashed = (text: string): string => text.replace(/\s+/g, '')

/** How many characters `a` and `b` share at their start (`end`: at their end). */
function shared(a: string, b: string, end = false): number {
  let count = 0
  while (count < a.length && count < b.length) {
    const x = end ? a[a.length - 1 - count] : a[count]
    const y = end ? b[b.length - 1 - count] : b[count]
    if (x !== y) break
    count++
  }
  return count
}

/**
 * Where in `sentence` the highlighted word is: of the places its text occurs, the one whose
 * surroundings best match what is drawn around it (the first on a tie); -1 when it is not there.
 */
export function locateWord(sentence: string, word: string, before = '', after = ''): number {
  if (!word) return -1
  let best = -1
  let score = -1
  for (let at = sentence.indexOf(word); at >= 0; at = sentence.indexOf(word, at + 1)) {
    const fit =
      shared(squashed(sentence.slice(at + word.length)), squashed(after)) +
      shared(squashed(sentence.slice(0, at)), squashed(before), true)
    if (fit > score) [best, score] = [at, fit]
  }
  return best
}

/** `sentence` with the `length` characters at `index` between the marks. */
export function markWord(sentence: string, index: number, length: number): string {
  const end = index + length
  return `${sentence.slice(0, index)}${MARK_OPEN}${sentence.slice(index, end)}${MARK_CLOSE}${sentence.slice(end)}`
}

/**
 * The request for the text on screen (`sections`), or null when there is none. The Log has the
 * screen's own text too, usually as its newest lines: those are the sentence, not its scene, so
 * any line that is one of the sections is left out of the context. `ocr`: the text was read with
 * OCR, not hooked from the game.
 */
export function explainRequest(
  sections: readonly unknown[] | null | undefined,
  recent: readonly RecentLine[] | null | undefined,
  stored: unknown,
  language: unknown,
  word?: string | Focus | null,
  { ocr = false }: { ocr?: boolean } = {}
): ExplainRequest | null {
  // Text read with OCR has a line break wherever it wraps on screen (`公` / `開中`): each section is
  // given as one run (`sectionText`, as Read along shows it), so a word across a break is whole
  // and the break is not taken for a misreading. The Log's OCR lines likewise.
  const run = (text: string, read: boolean): string => (read ? sectionText(text) : text)
  const shown = (sections ?? [])
    .map(clean)
    .filter(Boolean)
    .map((text) => run(text, ocr))
  if (!shown.length) return null
  const sentence = shown.join('\n')
  const onScreen = new Set(shown)
  const earlier = (recent ?? [])
    .map((line) => run(clean(line?.text), line?.source === 'ocr'))
    .filter((text) => text && !onScreen.has(text) && text !== sentence)
    .slice(0, CONTEXT_LINES)
    .reverse()
  const context = earlier.length ? earlier.join('\n') : '(no previous lines available)'
  const { prompt: template, focusPrompt } = explainSettings(stored)
  const asked = typeof word === 'string' ? { text: word } : word
  const focus = clean(asked?.text)
  if (!focus) {
    const prompt = explainPromptFor(template, language, context, sentence)
    return { sentence, context, word: null, at: null, ocr, prompt }
  }
  // The highlighted one marked where it is in the sentence, so a word whose text occurs more than
  // once there ("de" in "fiesta del fin de semana") is not taken for another.
  const at = locateWord(sentence, focus, asked?.before ?? '', asked?.after ?? '')
  const marked = at < 0 ? sentence : markWord(sentence, at, focus.length)
  const prompt = explainPromptFor(template, language, context, marked)
  return {
    sentence,
    context,
    word: focus,
    at: at < 0 ? null : at,
    ocr,
    prompt: `${prompt}\n\n${focusInstruction(focus, focusPrompt)}`
  }
}
