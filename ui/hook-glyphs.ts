/**
 * Where the game draws each character of a hooked line, from OCR's character boxes: the Text
 * Hooker card's glyphs go exactly there (overlay.js `hookCardView`).
 *
 * A line's box says where its ink starts and ends, which puts the card's first and last glyphs
 * near the game's, but not the ones between (a few percent of spacing is a character by the end of
 * a long row), nor a row the game starts further in (a quote's second row, under the first
 * character after 「). OCR engines that box each character (OneOCR) say where every glyph is. Each
 * row's characters are matched to the hooked text's (in order, skipping what OCR misread or left
 * out), and a straight line fitted through their centres, robustly (medians, so a misread or a box
 * stretched over two glyphs changes nothing):
 *
 * - `pitch`: how far apart the game's glyphs are, centre to centre (one value for the line: a game
 *   sets its dialogue in one size);
 * - each row's `start`: where the centre of its first character is (wherever that character inks:
 *   a 「 is placed by the row's other glyphs, not by its own ink, which sits at its em's right);
 * - each row's `middle`: the centre of its box from top to bottom.
 *
 * Brackets and punctuation take no part in the fit: their ink is off their em's centre, and not
 * where the card's font puts it. Everything is in the reading's pixels.
 *
 * Checked on Senren＊Banka against the game's own white ink (pixels, not another engine): Screen
 * AI's character boxes and Google Lens's word boxes (split evenly here) are centred on the ink to a
 * pixel or two; OneOCR boxes each character a little left of its ink and narrower than it, its
 * centre about a fifth of a glyph short ([`CENTRE_BIAS`]).
 */

export interface GlyphPiece {
  /** One character, or a run of them (a word) the engine boxed together. */
  text: string
  /** [left, top, right, bottom] */
  box: number[]
}

export interface GlyphRow {
  /** The centre of the row's first character; null when OCR matched too little of the row. */
  start: number | null
  /** The vertical centre of the row's glyphs; null as `start`. */
  middle: number | null
  /** Characters the fit used. */
  used: number
  /** Each of those characters and the vertical centre of its box: the card's own glyphs' ink is
   * placed on them, glyph by glyph (an engine boxes a short kana lower, and the card's font draws
   * it lower too). */
  marks: { c: string; y: number }[]
}

export interface GlyphGeometry {
  pitch: number
  rows: GlyphRow[]
  /** The fit's typical error, in pixels: how far a matched glyph's centre is from the line. */
  error: number
}

/** Ink off its em's centre, or nothing to place: brackets, punctuation, spaces. */
const OFF_CENTRE = /[\s\p{P}\p{S}ー〜～]/u

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function foldWidth(c: string): string {
  const code = c.codePointAt(0) ?? 0
  return code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : c
}

/** The longest common subsequence's pairs of indices. */
function align(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0 || n * m > 200_000) return []
  const width = m + 1
  const table = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
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

/** OCR's characters, each with its box: a piece of several characters is split evenly across. */
function characters(pieces: GlyphPiece[]): { c: string; x: number; y: number }[] {
  const out: { c: string; x: number; y: number }[] = []
  for (const piece of pieces) {
    const chars = [...piece.text].filter((c) => !/\s/u.test(c))
    if (!chars.length) continue
    const [x0, y0, x1, y1] = piece.box
    const w = (x1 - x0) / chars.length
    chars.forEach((c, i) => out.push({ c: foldWidth(c), x: x0 + (i + 0.5) * w, y: (y0 + y1) / 2 }))
  }
  return out
}

/**
 * The geometry of `rows` (the hooked line as the game breaks it, one string per row) from OCR's
 * `pieces` and each row's box (`rowBoxes`, [left, top, right, bottom], top row first). Null when
 * OCR's characters say too little: fewer than `MIN_GLYPHS` placed, or a fit too loose to trust.
 */
export function glyphGeometry(
  rows: string[],
  rowBoxes: number[][],
  pieces: GlyphPiece[],
  known: number | null = null,
  engine = ''
): GlyphGeometry | null {
  if (!rows.length || rows.length !== rowBoxes.length) return null
  // Each piece goes to the row whose box its centre is in, top to bottom.
  const byRow: GlyphPiece[][] = rows.map(() => [])
  for (const piece of pieces) {
    const cy = (piece.box[1] + piece.box[3]) / 2
    const cx = (piece.box[0] + piece.box[2]) / 2
    const r = rowBoxes.findIndex(
      ([x0, y0, x1, y1]) => cy >= y0 && cy <= y1 && cx >= x0 - (y1 - y0) && cx <= x1 + (y1 - y0)
    )
    if (r >= 0) byRow[r].push(piece)
  }
  // Each row's matched glyphs: [index in the row's text, centre x, centre y].
  const matched = rows.map((row, r) => {
    const text = [...row].map(foldWidth)
    const read = characters(byRow[r]).sort((a, b) => a.x - b.x)
    return align(
      text,
      read.map((g) => g.c)
    )
      .filter(([i]) => !OFF_CENTRE.test(text[i]))
      .map(([i, j]) => [i, read[j].x, read[j].y] as [number, number, number])
  })
  // The pitch: the median slope between glyphs of a row at least two apart.
  const slopes: number[] = []
  for (const glyphs of matched)
    for (let a = 0; a < glyphs.length; a++)
      for (let b = a + 1; b < glyphs.length; b++) {
        const di = glyphs[b][0] - glyphs[a][0]
        if (di >= 2) slopes.push((glyphs[b][1] - glyphs[a][1]) / di)
      }
  const total = matched.reduce((n, g) => n + g.length, 0)
  if (total < MIN_GLYPHS || slopes.length < 3) return null
  // A short line says little about the pitch (a few slopes, each off by OCR's pixel or two over a
  // short run): the pitch the game's long lines had (`known`), when there is one, is better.
  const pitch = known && total < OWN_PITCH_GLYPHS ? known : median(slopes)
  if (!(pitch > 0)) return null
  const fitted = matched.map((glyphs, r) => {
    // One glyph places a row, the pitch known from the others (a quote's last row, `よ」`).
    if (!glyphs.length) return { start: null, middle: null, used: 0, marks: [] }
    return {
      start: median(glyphs.map(([i, x]) => x - i * pitch)) - (CENTRE_BIAS[engine] ?? 0) * pitch,
      // The row's box, not its glyphs': engines box a short kana (い, ら) lower than a kanji, so a
      // row of mostly kana would look lower than it is.
      middle: (rowBoxes[r][1] + rowBoxes[r][3]) / 2,
      used: glyphs.length,
      marks: glyphs.map(([i, , y]) => ({ c: [...rows[r]][i], y }))
    }
  })
  if (fitted[0].start === null) return null
  const residuals = matched.flatMap((glyphs, r) =>
    fitted[r].start === null ? [] : glyphs.map(([i, x]) => Math.abs(x - (fitted[r].start! + i * pitch)))
  )
  const error = median(residuals)
  // Loose: OCR's characters were not where one straight row of glyphs would put them.
  if (error > pitch * MAX_ERROR) return null
  return { pitch, rows: fitted, error }
}

/**
 * How far right of a glyph's ink an engine centres its box, in pitches (negative: to the left).
 * OneOCR's ヘ in Senren＊Banka: boxed 505–530 px, its ink 509–547 (a 39 px pitch).
 */
export const CENTRE_BIAS: Record<string, number> = { oneocr: -0.18 }

/** The fewest glyphs that measure a line's own pitch, when the game's is `known`. */
export const OWN_PITCH_GLYPHS = 14

/** The fewest glyphs a fit takes. */
const MIN_GLYPHS = 5
/** The loosest typical error a fit may have, in pitches. */
const MAX_ERROR = 0.2

/**
 * How far right of the card's first row each row of a wrapped line starts (a margin before the
 * row, hook-card.js), so each row's ink starts where OCR found the game's: a row the game indents
 * (現実的な… a full-width space in, under a full first row) is indented on the card too, by as
 * much. For an engine that boxes only lines, not characters (the glyphs then place the rows,
 * `glyphGeometry`).
 *
 * OCR's geometry decides, not the hooked text's whitespace, which varies by game: a row whose text
 * starts with the indent (a full-width space U+3000, spaces) already inks that far in on the card,
 * and is moved only by what the game's indent differs from it; a row whose text has none is moved
 * by all of it.
 *
 * - `rowLefts`: where the game's ink of each row starts (OCR's row boxes' left edges), in pixels;
 * - `inkLefts`: where the card's own ink of each row starts in its row at no letter-spacing (a
 *   leading U+3000, or the ink of a 「 well inside its em);
 * - `leads`: the whitespace characters each row starts with, each one a letter-spacing further in;
 * - `spacing`: the card's letter-spacing; `fontPx`: its size. A difference of less than
 *   [`ROW_INDENT_SNAP`] of an em is OCR's few pixels of give, not an indent: none.
 */
export function rowIndents(
  rowLefts: number[],
  inkLefts: number[],
  leads: number[],
  spacing: number,
  fontPx: number
): number[] {
  const n = rowLefts.length
  if (!n || inkLefts.length !== n || leads.length !== n) return rowLefts.map(() => 0)
  const ink = (i: number): number => inkLefts[i] + leads[i] * spacing
  return rowLefts.map((left, i) => {
    if (i === 0) return 0
    const indent = left - rowLefts[0] - (ink(i) - ink(0))
    return Math.abs(indent) < ROW_INDENT_SNAP * fontPx ? 0 : indent
  })
}

/** The whitespace a row starts with, in characters (U+3000, ASCII spaces, tabs). */
export const leadingSpaces = (row: string): number => [...(/^\s*/u.exec(row)?.[0] ?? '')].length

/** The least difference between two rows' starts that is an indent, in ems ([`rowIndents`]). */
export const ROW_INDENT_SNAP = 0.2
