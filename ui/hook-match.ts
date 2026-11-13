/**
 * Placing a hooked line on the overlay: OCR says *where* the text is, the hook says *what* it is.
 *
 * The Text Hooker (src-tauri/src/text_hook) gives the exact text of the game's dialogue, but no
 * position. Auto OCR gives positions, with misreads, and reads everything on screen: nameplates,
 * menus, HUD strings. This finds the block of OCR text that is the hooked line and replaces its
 * text with the hooked text, keeping OCR's line boxes, so the overlay shows the right words in the
 * right place.
 *
 * - **Candidates**: each OCR group, runs of groups stacked under each other (OCR may split a
 *   dialogue box in two), and runs of lines within a group (OCR, or the scene reading lines close
 *   together as one passage, may join two paragraphs of a page of text into one).
 * - **Score**: the longest common subsequence of the candidate's text and the hooked line, after
 *   folding width and dropping whitespace and punctuation. *Recall* is how much of the hooked line
 *   the candidate holds, *precision* how much of the candidate is the hooked line. Both must be
 *   high: a nameplate or a menu shares a few characters with the line but holds little of it, and
 *   a box that also takes in the nameplate holds more than the line. A subsequence, not exact
 *   containment, because OCR misreads a character here and there.
 * - **Replace**: the matched groups become one group with the hooked text, split across OCR's
 *   lines where OCR's line breaks fall in the alignment.
 *
 * No match is a result too: the caller then shows the line in its fallback box.
 */
import type { OcrGroup } from './ocr-result.js'
import type { Annotation } from './geometry.js'

/** Characters that never decide a match (whitespace and punctuation, which OCR drops or misreads). */
const IGNORED = /[\s\p{P}\p{S}]/u

function foldWidth(c: string): string {
  const code = c.codePointAt(0) ?? 0
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCodePoint(code - 0xfee0)
  return c
}

/** The characters compared, with each one's index in the original text. */
export function normalized(text: string): { chars: string[]; at: number[] } {
  const chars: string[] = []
  const at: number[] = []
  let index = 0
  for (const raw of text) {
    const c = foldWidth(raw)
    // The long-vowel mark is a letter, not punctuation, for matching.
    if (c === 'ー' || !IGNORED.test(c)) {
      chars.push(c.toLowerCase())
      at.push(index)
    }
    index += raw.length
  }
  return { chars, at }
}

/**
 * A hooked line's text with its line breaks taken out, for a row or a block of one line. In
 * Japanese a break is nothing (the game wrapped a word in two: 自転 / 車). In a language that
 * spaces its words (`spaces`) a break between two words is a space; one at the very start is
 * nothing, as before. Matching never sees the difference: `normalized` drops whitespace on both
 * sides.
 */
function unbroken(text: string, spaces = false): string {
  return spaces ? text.replace(/^\s*\n\s*/, '').replace(/\s*\n\s*/g, ' ') : text.replace(/\n/g, '')
}

/** LCS alignment: pairs (index in a, index in b), in order. */
function align(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  // Lines are short (a dialogue box is a few hundred characters at most); cap to stay cheap.
  if (n === 0 || m === 0 || n * m > 400_000) return []
  const width = m + 1
  const table = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++
    else j++
  }
  return pairs
}

export interface HookPlacement {
  /** The groups to draw: the matched ones replaced by one group carrying the hooked text. */
  groups: OcrGroup[]
  /** The new group's id, or null when nothing on screen is the hooked line. */
  matched: string | null
  recall: number
  precision: number
}

/** Least share of the hooked line a block must hold, and of the block that must be the line. */
export const MIN_RECALL = 0.6
export const MIN_PRECISION = 0.55

/** The text of each line of a group, as OCR read it. */
function groupLines(group: OcrGroup): string[] {
  const count = group.linePolygons?.length ?? 0
  if (group.lines && group.lines.length === count && count > 0) return group.lines
  if (count > 1) {
    const split = group.text.split('\n')
    if (split.length === count) return split
  }
  if (group.lineSegments && group.lineSegments.length === count && count > 0)
    return group.lineSegments.map((segments) => segments.map((s) => s.text).join(''))
  return [group.text]
}

function stacked(above: OcrGroup, below: OcrGroup): boolean {
  if (!above.bbox || !below.bbox || above.orientation !== below.orientation) return false
  const [ax0, ay0, ax1, ay1] = above.bbox
  const [bx0, by0, bx1, by1] = below.bbox
  if (above.orientation === 'vertical') {
    // Columns run right to left; the next one sits to the left, overlapping vertically.
    const gap = ax0 - bx1
    const size = Math.max(ax1 - ax0, bx1 - bx0)
    return gap > -size * 0.5 && gap < size * 1.5 && by0 < ay1 && by1 > ay0
  }
  const gap = by0 - ay1
  const size = Math.max((ay1 - ay0) / Math.max(1, above.linePolygons?.length ?? 1), 1)
  return gap > -size * 0.5 && gap < size * 1.6 && bx0 < ax1 && bx1 > ax0
}

/**
 * The runs of consecutive lines within a group of several, each as a group of its own (`#i-j`):
 * a block OCR (or the scene, which reads lines close together as one passage) made of two
 * paragraphs holds the line as only some of its lines.
 */
function lineRuns(group: OcrGroup): OcrGroup[] {
  const polygons = group.linePolygons ?? []
  const lines = groupLines(group)
  if (polygons.length < 2 || lines.length !== polygons.length || polygons.length > 16) return []
  const runs: OcrGroup[] = []
  for (let from = 0; from < lines.length; from++) {
    for (let to = from; to < lines.length; to++) {
      if (from === 0 && to === lines.length - 1) continue
      const points = polygons.slice(from, to + 1).flat()
      const xs = points.map(([x]) => x)
      const ys = points.map(([, y]) => y)
      runs.push({
        ...group,
        id: `${group.id}#${from}-${to}`,
        text: lines.slice(from, to + 1).join('\n'),
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        linePolygons: polygons.slice(from, to + 1),
        lines: lines.slice(from, to + 1)
      })
    }
  }
  return runs
}

/** Runs of up to four groups read in order, each stacked on the one before; and runs of lines. */
function candidates(groups: OcrGroup[]): OcrGroup[][] {
  const order = groups
    .filter((g) => g.bbox && g.text.trim())
    .sort((a, b) =>
      a.orientation === 'vertical' && b.orientation === 'vertical'
        ? b.bbox![0] - a.bbox![0]
        : a.bbox![1] - b.bbox![1] || a.bbox![0] - b.bbox![0]
    )
  const runs: OcrGroup[][] = []
  for (let start = 0; start < order.length; start++) {
    const run = [order[start]]
    runs.push([...run])
    for (let next = start + 1; next < order.length && run.length < 4; next++) {
      if (!stacked(run[run.length - 1], order[next])) continue
      run.push(order[next])
      runs.push([...run])
    }
  }
  for (const group of order) for (const lines of lineRuns(group)) runs.push([lines])
  return runs
}

/**
 * Splits `hooked` across lines whose OCR texts are `ocrLines`, cutting where OCR's line breaks
 * fall in the alignment. Punctuation between two lines stays with the earlier one.
 */
export function splitAcrossLines(hooked: string, ocrLines: string[], spaces = false): string[] {
  if (ocrLines.length <= 1) return [hooked]
  // The game's own line breaks, when there are as many lines as OCR saw, are where it wrapped.
  const own = hooked.split('\n')
  if (own.length === ocrLines.length) return own
  const target = normalized(hooked)
  const pieces = ocrLines.map((line) => normalized(line).chars)
  const joined = pieces.flat()
  const pairs = align(joined, target.chars)
  const cuts: number[] = []
  let end = 0
  for (const piece of pieces.slice(0, -1)) {
    end += piece.length
    // The hooked character after the last one matched inside this line starts the next line.
    let next = cuts.at(-1) ?? 0
    for (const [i, j] of pairs) if (i < end) next = Math.max(next, j + 1)
    cuts.push(next)
  }
  const offset = (normIndex: number): number => (normIndex >= target.at.length ? hooked.length : target.at[normIndex])
  const out: string[] = []
  // In a language that spaces its words, the space where a line was cut is between two words,
  // not an indent: the next line starts on its word.
  const row = (piece: string): string =>
    spaces && out.length ? unbroken(piece, spaces).replace(/^\s+/, '') : unbroken(piece, spaces)
  let from = 0
  for (const cut of cuts) {
    let to = Math.max(from, offset(cut))
    // A line ends on its text: an indent (or a space) starts the next one.
    while (to > from && /\s/.test(hooked[to - 1])) to--
    out.push(row(hooked.slice(from, to)))
    from = to
  }
  out.push(row(hooked.slice(from)))
  return out
}

/**
 * Places `hooked` on the OCR groups: see the module comment. `spaces`: the language puts spaces
 * between words, so the hooked line's breaks become spaces in the placed text (`unbroken`).
 */
export function placeHookedLine(groups: OcrGroup[], hooked: string, spaces = false): HookPlacement {
  const target = normalized(hooked).chars
  const none: HookPlacement = { groups, matched: null, recall: 0, precision: 0 }
  if (target.length < 2) return none
  let best: { run: OcrGroup[]; recall: number; precision: number; score: number } | null = null
  for (const run of candidates(groups)) {
    const text = run.flatMap((g) => normalized(g.text).chars)
    if (text.length === 0) continue
    const common = align(text, target).length
    const recall = common / target.length
    const precision = common / text.length
    // Short lines (a word or two) must be read almost exactly.
    const minRecall = target.length < 6 ? 0.85 : MIN_RECALL
    if (recall < minRecall || precision < MIN_PRECISION) continue
    const score = (2 * recall * precision) / (recall + precision)
    if (!best || score > best.score) best = { run, recall, precision, score }
  }
  if (!best) return none
  const run = best.run
  const lines = run.flatMap(groupLines)
  const polygons = run.flatMap((g) => g.linePolygons ?? [])
  const boxes = run.map((g) => g.bbox!)
  const id = `hook:${run.map((g) => g.id).join('+')}`
  const placed: OcrGroup = {
    ...run[0],
    id,
    text: unbroken(hooked, spaces),
    bbox: [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3]))
    ],
    linePolygons: polygons.length === lines.length ? polygons : run[0].linePolygons,
    lines: polygons.length === lines.length ? splitAcrossLines(hooked, lines, spaces) : undefined,
    // OCR's word boxes belong to OCR's text, not the hooked text.
    lineSegments: undefined,
    inferred: undefined
  }
  // A run of a group's lines takes the group's place.
  const used = new Set(run.map((g) => g.id.replace(/#.*$/, '')))
  const index = groups.findIndex((g) => used.has(g.id))
  const rest = groups.filter((g) => !used.has(g.id))
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, placed)
  return { groups: rest, matched: id, recall: best.recall, precision: best.precision }
}

// ---------------------------------------------------------------------------- the overlay's side

/** The overlay's drawn annotations (`state.annotations`): index 0 may be the whole-text aggregate. */
type Ann = Annotation

function boxOf(a: Annotation): [number, number, number, number] {
  const xs = a.boundingPoly.vertices.map((v) => v.x ?? 0)
  const ys = a.boundingPoly.vertices.map((v) => v.y ?? 0)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const polygon = ([x0, y0, x1, y1]: number[]): number[][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1]
]

/**
 * The OCR groups the drawn annotations make: an engine's blocks as they are, and fragments
 * (words or lines) gathered by their `groupId` into rows.
 */
export function annotationGroups(annotations: Annotation[]): OcrGroup[] {
  const words =
    annotations.length > 1 && annotations[0].granularity === 'aggregate' ? annotations.slice(1) : annotations
  const groups: OcrGroup[] = []
  const pieces = new Map<string, Annotation[]>()
  words.forEach((a, index) => {
    if (a.granularity === 'block') {
      groups.push({
        id: a.groupId ?? `block-${index}`,
        text: a.description,
        bbox: boxOf(a),
        orientation: a.orientation === 'vertical' ? 'vertical' : 'horizontal',
        linePolygons: a.linePolygons?.length ? a.linePolygons : [polygon(boxOf(a))],
        lines: a.lineTexts?.length ? a.lineTexts : undefined
      })
      return
    }
    const id = a.groupId ?? `fragment-${index}`
    pieces.set(id, [...(pieces.get(id) ?? []), a])
  })
  for (const [id, members] of pieces) {
    const vertical = members.every((m) => m.orientation === 'vertical' || m.isVertical)
    // Rows (or columns): members whose spans across the line overlap.
    const rows: Annotation[][] = []
    const across = (a: Annotation): [number, number] => {
      const b = boxOf(a)
      return vertical ? [b[0], b[2]] : [b[1], b[3]]
    }
    for (const member of [...members].sort((a, b) =>
      vertical ? boxOf(b)[0] - boxOf(a)[0] : boxOf(a)[1] - boxOf(b)[1]
    )) {
      const [s, e] = across(member)
      const row = rows.find((r) => {
        const [rs, re] = across(r[0])
        return Math.min(e, re) - Math.max(s, rs) > 0.4 * Math.min(e - s, re - rs)
      })
      if (row) row.push(member)
      else rows.push([member])
    }
    const along = (a: Annotation): number => (vertical ? boxOf(a)[1] : boxOf(a)[0])
    const rowBoxes = rows.map((row) => {
      const boxes = row.map(boxOf)
      return [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3]))
      ]
    })
    const lines = rows.map((row) =>
      [...row]
        .sort((a, b) => along(a) - along(b))
        .map((m) => m.description)
        .join('')
    )
    groups.push({
      id,
      text: lines.join('\n'),
      bbox: [
        Math.min(...rowBoxes.map((b) => b[0])),
        Math.min(...rowBoxes.map((b) => b[1])),
        Math.max(...rowBoxes.map((b) => b[2])),
        Math.max(...rowBoxes.map((b) => b[3]))
      ],
      orientation: vertical ? 'vertical' : 'horizontal',
      linePolygons: rowBoxes.map(polygon),
      lines
    })
  }
  return groups
}

// ------------------------------------------------------------------------------- speakers' names

/** A hooked line with its speaker's name, as visual novels send it: `アキ「……」`, or `「……」\nアキ`. */
export interface Speech {
  name: string
  body: string
  /**
   * The game sent the name after the quote, on a line of its own (`trailingSpeaker`): a name
   * for certain, so the quote is shown alone whether or not OCR finds the name on screen.
   */
  after?: true
}

const QUOTES: Record<string, string> = { '「': '」', '『': '』', '（': '）', '(': ')', '“': '”' }

/**
 * The speaker's name and what they say, when the line is a short name and then one quote and
 * nothing else: `アキ「……」`, `【アキ】「……」`, `アキ：「……」`, `？？？「……」`. A name holds no
 * sentence punctuation (、。) nor a quote of its own, so narration around a quote
 * (`彼は「はい」と言った。`) is not a speech. Some narration still looks like one (`そして「……」`):
 * the caller only takes a speech as one where OCR finds the name apart from the quote.
 */
export function splitSpeaker(text: string): Speech | null {
  const chars = [...text.trim()]
  const open = chars.findIndex((c) => c in QUOTES)
  if (open === 0) return trailingSpeaker(chars)
  if (open < 1) return null
  return speech(chars.slice(0, open).join(''), chars.slice(open).join(''))
}

/**
 * Some games send the name after the quote, on a line of its own: `（……）\n蒼`. The name must be
 * set apart (a line break or a space), so narration that carries on after a quote
 * (`「はい」と言った。`) is not taken for one.
 */
function trailingSpeaker(chars: string[]): Speech | null {
  const end = chars.lastIndexOf(QUOTES[chars[0]])
  if (end < 2 || end === chars.length - 1) return null
  const after = chars.slice(end + 1).join('')
  if (!/^\s/u.test(after)) return null
  const found = speech(after, chars.slice(0, end + 1).join(''))
  return found && { ...found, after: true }
}

/** A name and a quote, when the name reads as one and the quote is whole. */
function speech(rawName: string, rawBody: string): Speech | null {
  let name = rawName.trim().replace(/^[：:\s]+|[：:\s]+$/gu, '')
  const bracketed = /^【(.+)】$/u.exec(name)
  if (bracketed) name = bracketed[1].trim()
  const body = rawBody.trim()
  if (!name || [...name].length > 16 || /[、。，．「」『』（）()【】\n]/u.test(name)) return null
  if ([...body].length < 3 || !body.endsWith(QUOTES[body[0]])) return null
  return { name, body }
}

/** How far apart two boxes are across and down; 0 where they overlap. */
const boxGap = (a: number[], b: number[]): { x: number; y: number } => ({
  x: Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2])),
  y: Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]))
})

/** Every single line OCR read, as a group of its own. */
function eachLine(groups: OcrGroup[]): OcrGroup[] {
  return groups.flatMap((group) => {
    if ((group.linePolygons?.length ?? 1) <= 1) return [group]
    return lineRuns(group).filter((run) => run.linePolygons?.length === 1)
  })
}

/**
 * The speaker's name on screen, apart from what they say (`body`, where the quote was found): a
 * line of its own that reads as the name, near the quote (above it, or before it on its row, as a
 * nameplate is), or where the game showed a name before (`near`). Null when there is none: the
 * game shows the name inline, or OCR missed it.
 */
function findName(
  groups: OcrGroup[],
  name: string,
  body: [number, number, number, number],
  bodyLines: number,
  near: [number, number, number, number] | null,
  trailing: boolean = false
): OcrGroup | null {
  const target = normalized(name).chars
  if (!target.length) return null
  const line = (body[3] - body[1]) / Math.max(1, bodyLines)
  let best: { group: OcrGroup; score: number } | null = null
  for (const group of eachLine(groups)) {
    const box = group.bbox
    if (!box) continue
    const text = normalized(group.text).chars
    if (!text.length) continue
    const common = align(text, target).length
    const recall = common / target.length
    const precision = common / text.length
    // A short name must be read whole; a longer one may have a character misread.
    if (recall < (target.length <= 3 ? 1 : 0.7) || precision < 0.6) continue
    // Not one of the quote's own lines.
    const apart = boxGap(box, body)
    if (apart.x === 0 && apart.y === 0) continue
    const above =
      box[3] <= body[1] + line * 0.3 && body[1] - box[3] < line * 3 && box[0] < body[2] && box[2] > body[0] - line * 8
    const before =
      box[2] <= body[0] + line * 0.3 && body[0] - box[2] < line * 8 && box[1] < body[1] + line && box[3] > body[1]
    const there = near !== null && boxGap(box, near).x < line * 2 && boxGap(box, near).y < line
    // A name the game sends after the quote may also be drawn under it, or after its last row.
    const below =
      trailing &&
      box[1] >= body[3] - line * 0.3 &&
      box[1] - body[3] < line * 3 &&
      box[0] < body[2] + line * 8 &&
      box[2] > body[0]
    const after =
      trailing &&
      box[0] >= body[2] - line * 0.3 &&
      box[0] - body[2] < line * 8 &&
      box[1] < body[3] &&
      box[3] > body[3] - line
    if (!above && !before && !below && !after && !there) continue
    const score = (2 * recall * precision) / (recall + precision) + (there ? 0.1 : 0)
    if (!best || score > best.score) best = { group, score }
  }
  return best?.group ?? null
}

/**
 * The speaker's name read as a line of its own with nothing of the quote to go by: where the game
 * showed a name before (`near`), or, without that, a line that is the name with a line of
 * punctuation just under it (`lineUnder`), as a nameplate over 「……」 is.
 */
function nameAlone(groups: OcrGroup[], name: string, near: [number, number, number, number] | null): OcrGroup | null {
  const target = normalized(name).chars
  if (!target.length) return null
  let best: { group: OcrGroup; score: number } | null = null
  for (const group of eachLine(groups)) {
    const box = group.bbox
    if (!box) continue
    const text = normalized(group.text).chars
    const common = align(text, target).length
    const recall = common / target.length
    const precision = text.length ? common / text.length : 0
    if (recall < (target.length <= 3 ? 1 : 0.7) || precision < 0.8) continue
    const line = box[3] - box[1]
    const there = near ? boxGap(box, near).x < line * 2 && boxGap(box, near).y < line : lineUnder(groups, box) !== null
    if (!there) continue
    const score = (2 * recall * precision) / (recall + precision)
    if (!best || score > best.score) best = { group, score }
  }
  return best?.group ?? null
}

/** The line just under `box` (a nameplate) that holds little but punctuation, as 「……」 is read. */
function lineUnder(groups: OcrGroup[], box: [number, number, number, number]): OcrGroup | null {
  const line = box[3] - box[1]
  let best: { group: OcrGroup; gap: number } | null = null
  for (const group of eachLine(groups)) {
    const under = group.bbox
    if (!under || !group.text.trim() || normalized(group.text).chars.length > 2) continue
    const gap = under[1] - box[3]
    if (gap < -line * 0.3 || gap > line * 2.5) continue
    if (under[0] > box[2] + line * 8 || under[2] < box[0] - line * 8) continue
    if (!best || gap < best.gap) best = { group, gap }
  }
  return best?.group ?? null
}

export interface HookedAnnotations {
  /** What to draw: only the hooked line's block when it was found, else nothing. */
  annotations: Ann[]
  /** Where the line is on screen, in capture pixels; null when it was not found. */
  box: [number, number, number, number] | null
  recall: number
  precision: number
  /** The text the card shows: the hooked line, or what its speaker says when the name is apart. */
  shown: string
  /** The speaker's name where the game shows it, as OCR text to draw (empty without one). */
  names: Ann[]
  /** Where that name is, in capture pixels; null without one. */
  nameBox: [number, number, number, number] | null
}

/** A group as one drawn block, with the look (ink margins, typeface, surface) of what it came from. */
function blockOf(group: OcrGroup, annotations: Annotation[]): Ann {
  const members = new Set(
    group.id
      .replace(/^(hook|name):/, '')
      .split('+')
      .map((id) => id.replace(/#.*$/, ''))
  )
  const source =
    annotations.find((a) => a.groupId !== undefined && members.has(a.groupId)) ??
    annotations.find((a) => a.granularity !== 'aggregate')
  return {
    description: group.text,
    granularity: 'block',
    groupId: group.id,
    orientation: group.orientation,
    isVertical: group.orientation === 'vertical',
    linePolygons: group.linePolygons,
    ...(group.lines ? { lineTexts: group.lines } : {}),
    ...(source?.inkMargin ? { inkMargin: source.inkMargin } : {}),
    ...(source?.typeface ? { typeface: source.typeface } : {}),
    ...(source?.surface ? { surface: source.surface } : {}),
    boundingPoly: { vertices: polygon(group.bbox!).map(([x, y]) => ({ x, y })) }
  }
}

/**
 * The speaker's name drawn on the game's nameplate where OCR did not read it this time (a lone
 * character, say, which OCR finds only now and then): at the plate's place (`nameAt`, learned
 * from a reading that did find a name), as wide as the name at the plate's height.
 */
function plateName(name: string, nameAt: [number, number, number, number] | null, annotations: Annotation[]): Ann[] {
  if (!nameAt) return []
  const height = nameAt[3] - nameAt[1]
  if (!(height > 0)) return []
  const box: [number, number, number, number] = [nameAt[0], nameAt[1], nameAt[0] + height * [...name].length, nameAt[3]]
  return [
    blockOf(
      {
        id: 'name:plate',
        text: name,
        lines: [name],
        bbox: box,
        orientation: 'horizontal',
        linePolygons: [polygon(box)]
      },
      annotations
    )
  ]
}

/**
 * Places the hooked line on what OCR read. On a match the result is the one block, carrying the
 * hooked text on OCR's lines; everything else OCR read (menus, misreads) is dropped, because the
 * hooked line is the only text known to be right. No match: nothing.
 *
 * A line its speaker's name leads (`splitSpeaker`) where the game shows the name apart (a
 * nameplate over the text box): the block is the quote alone, where the quote is, and the name is
 * drawn as OCR text where the nameplate is (`names`), carrying the hooked name. `nameAt` is where
 * the game showed a name before, in capture pixels; `apart`, that it shows names so, takes the
 * quote alone even where OCR did not read the name. With `speakers` off (the reader turned
 * speakers' names off), every line is placed whole.
 */
export function hookAnnotations(
  annotations: Annotation[],
  hooked: string,
  {
    nameAt = null,
    apart = false,
    speakers = true,
    spaces = false
  }: {
    nameAt?: [number, number, number, number] | null
    apart?: boolean
    speakers?: boolean
    /** The language puts spaces between words (`placeHookedLine`). */
    spaces?: boolean
  } = {}
): HookedAnnotations {
  const groups = annotationGroups(annotations)
  const speech = speakers ? splitSpeaker(hooked) : null
  // A quote with (almost) nothing but punctuation in it (「……」, 「っ！」) has nothing to match by:
  // the name says where it is, the line just under it (what OCR made of the dots, if anything).
  if (speech && normalized(speech.body).chars.length < 2) {
    const name = nameAlone(groups, speech.name, nameAt)
    if (name?.bbox) {
      const names = [blockOf({ ...name, id: `name:${name.id}`, text: speech.name, lines: [speech.name] }, annotations)]
      const under = lineUnder(groups, name.bbox)
      if (under?.bbox) {
        const quote = { ...under, id: `hook:${under.id}`, text: speech.body, lines: [speech.body] }
        return {
          annotations: [blockOf(quote, annotations)],
          box: under.bbox,
          recall: 1,
          precision: 1,
          shown: speech.body,
          names,
          nameBox: name.bbox
        }
      }
      return { annotations: [], box: null, recall: 0, precision: 0, shown: speech.body, names, nameBox: name.bbox }
    }
    // Matched whole, such a line would be its name alone: on the nameplate, not the text box.
    const shown = apart || speech.after ? speech.body : hooked
    const names = shown === hooked ? [] : plateName(speech.name, nameAt, annotations)
    return { annotations: [], box: null, recall: 0, precision: 0, shown, names, nameBox: null }
  }
  if (speech) {
    const body = placeHookedLine(groups, speech.body, spaces)
    const group = body.groups.find((g) => g.id === body.matched)
    if (group?.bbox && body.recall >= 0.9 && body.precision >= 0.8) {
      const name = findName(groups, speech.name, group.bbox, group.linePolygons?.length ?? 1, nameAt, speech.after)
      if (name?.bbox || apart || speech.after) {
        const drawn = name?.bbox
          ? [blockOf({ ...name, id: `name:${name.id}`, text: speech.name, lines: [speech.name] }, annotations)]
          : plateName(speech.name, nameAt, annotations)
        return {
          annotations: [blockOf(group, annotations)],
          box: group.bbox,
          recall: body.recall,
          precision: body.precision,
          shown: speech.body,
          names: drawn,
          nameBox: name?.bbox ?? null
        }
      }
    }
  }
  // A name sent after the quote is never part of the card, wherever the quote is.
  const line = speech?.after ? speech.body : hooked
  const placement = placeHookedLine(groups, line, spaces)
  const group = placement.groups.find((g) => g.id === placement.matched)
  const rest = { recall: placement.recall, precision: placement.precision, shown: line, names: [], nameBox: null }
  if (!group?.bbox) return { annotations: [], box: null, ...rest }
  return { annotations: [blockOf(group, annotations)], box: group.bbox, ...rest }
}
