/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Laying grouped text over the source so each character lands on the one it was read from.
 *
 * The text is split into runs — a line, or a word on a line — and every run is placed in the
 * rectangle OCR found for it, then fitted along its length: the font is sized to the run's
 * thickness, and the space between characters makes the run exactly as long as the original,
 * with each glyph centred in its share of that length. Japanese is set on a grid of near-equal
 * cells, so a run that starts and ends where the original does lines up all along.
 *
 * Runs come from the best evidence available, in order:
 *
 *   1. a box per line or per word (cloud OCR, MeikiOCR): each box is a run
 *   2. a box per bubble with the lines found inside it (Manga OCR's line polygons): the bubble's
 *      text, which arrives unbroken, is shared out across the lines in proportion to their length
 *   3. a box per bubble and nothing more: the number of lines and the size that fill the box best
 *      are worked out, and the text is set as that many evenly spaced lines
 *
 * Pure: the caller supplies `measure`, the text's natural advance in ems, so this runs in tests.
 */

/** Glyph size against the run's thickness: OCR boxes sit a little outside the ink. */
export const INK = 0.92
/** Line pitch against glyph size, when the lines have to be guessed: typical game and manga leading. */
export const LEADING = 1.35

/** Characters as the reader sees them: one per code point. */
export const chars = (text) => [...text]

/**
 * Share `count` characters across lines in proportion to their capacity, by the largest
 * remainder, so the totals always add up and no line with room is left empty.
 */
export function apportion(count, capacities) {
  const total = capacities.reduce((sum, value) => sum + Math.max(0, value), 0)
  if (!capacities.length) return []
  if (total <= 0) {
    const even = capacities.map(
      (_, index) =>
        Math.floor(count / capacities.length) + (index < count % capacities.length ? 1 : 0)
    )
    return even
  }
  const exact = capacities.map((value) => (count * Math.max(0, value)) / total)
  const shares = exact.map(Math.floor)
  let left = count - shares.reduce((sum, value) => sum + value, 0)
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder)
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) shares[order[i].index]++
  return shares
}

/** Lines in reading order: top to bottom across, right to left for vertical columns. */
export function readingOrder(rects, vertical) {
  return [...rects].sort((a, b) =>
    vertical ? b.x + b.width / 2 - (a.x + a.width / 2) : a.y + a.height / 2 - (b.y + b.height / 2)
  )
}

/**
 * The text of one bubble shared across the lines found inside it.
 *
 * Text that already carries as many line breaks as there are lines keeps them. Otherwise each
 * line's capacity is its length over its thickness — how many square glyphs it holds — and the
 * characters are shared out by capacity.
 */
export function distribute(text, lineRects, vertical) {
  const lines = readingOrder(lineRects, vertical)
  const broken = text.split('\n')
  if (broken.length === lines.length) {
    return lines.map((rect, index) => ({ text: broken[index], rect }))
  }
  const all = chars(text.replace(/\n/g, ''))
  const capacities = lines.map((rect) =>
    vertical ? rect.height / Math.max(1, rect.width) : rect.width / Math.max(1, rect.height)
  )
  const shares = apportion(all.length, capacities)
  let at = 0
  return lines
    .map((rect, index) => {
      const piece = all.slice(at, at + shares[index]).join('')
      at += shares[index]
      return { text: piece, rect }
    })
    .filter((run) => run.text)
}

/**
 * Lines for a bubble with no line geometry: the count, and so the size, that fills the box best.
 *
 * Explicit line breaks are kept and only their size is chosen. Without any, every count from one
 * line up is tried: `n` characters over `lines` lines of `ceil(n / lines)` cells must fit the
 * box's length, and `lines` rows at LEADING pitch its breadth; the count with the largest glyph
 * wins. Lines are then filled to the edge, as wrapped text is, and spread evenly across the
 * breadth, each starting at the box's edge.
 */
export function estimate(text, rect, vertical) {
  const along = vertical ? rect.height : rect.width
  const across = vertical ? rect.width : rect.height
  const explicit = text.split('\n')
  let rows
  if (explicit.length > 1) {
    rows = explicit
  } else {
    const all = chars(text)
    let best = { size: 0, lines: 1 }
    for (let lines = 1; lines <= all.length; lines++) {
      const perLine = Math.ceil(all.length / lines)
      const size = Math.min(along / perLine, across / (lines + (lines - 1) * (LEADING - 1)))
      if (size > best.size) best = { size, lines }
    }
    // Wrapped text fills every line to the edge and leaves the remainder on the last, so a
    // line holds as many cells of the chosen size as fit, not an even share of the text.
    const perLine = Math.max(
      Math.ceil(all.length / best.lines),
      Math.floor(along / best.size + 1e-6)
    )
    rows = []
    for (let i = 0; i < all.length; i += perLine) rows.push(all.slice(i, i + perLine).join(''))
  }
  const longest = Math.max(1, ...rows.map((row) => chars(row).length))
  const size = Math.min(along / longest, across / (rows.length + (rows.length - 1) * (LEADING - 1)))
  const pitch = rows.length > 1 ? (across - size) / (rows.length - 1) : 0
  const cell = along / longest
  return rows
    .map((row, index) => {
      const length = chars(row).length * cell
      // Horizontal lines run down the box; vertical columns run right to left.
      const offset = rows.length > 1 ? index * pitch : (across - size) / 2
      return {
        text: row,
        rect: vertical
          ? { x: rect.x + rect.width - offset - size, y: rect.y, width: size, height: length }
          : { x: rect.x, y: rect.y + offset, width: length, height: size }
      }
    })
    .filter((run) => run.text)
}

/**
 * Fit one run into its rectangle.
 *
 * `measure(text)` is the text's natural advance in ems. The glyph is the run's thickness (less a
 * margin for the box around the ink), unless that would overrun the length with no space left
 * between characters; the leftover length becomes letter spacing, half of it before the first
 * glyph so every glyph sits in the middle of its cell.
 */
export function fit(run, vertical, measure) {
  const { rect, text } = run
  const count = Math.max(1, chars(text).length)
  const along = vertical ? rect.height : rect.width
  const across = vertical ? rect.width : rect.height
  const ems = Math.max(0.01, measure(text))
  const fontSize = Math.max(1, Math.min(across * INK, along / ems))
  const spacing = (along - ems * fontSize) / count
  return { ...run, fontSize, spacing, lead: spacing / 2 }
}

/**
 * Every run of a group, fitted.
 *
 * @param {{text: string, rect: {x: number, y: number, width: number, height: number}, lines?: {x: number, y: number, width: number, height: number}[], block?: boolean}[]} parts
 *   the group's annotations in reading order, already in overlay coordinates: a block carries the
 *   line rectangles found inside it, if any
 * @param {boolean} vertical
 * @param {(text: string) => number} measure
 */
export function layoutGroup(parts, vertical, measure) {
  const runs = []
  for (const part of parts) {
    if (!part.text) continue
    if (part.block || part.text.includes('\n')) {
      const lines = part.lines?.length
        ? distribute(part.text, part.lines, vertical)
        : estimate(part.text, part.rect, vertical)
      runs.push(...lines)
    } else {
      runs.push({ text: part.text, rect: part.rect })
    }
  }
  return runs.map((run) => fit(run, vertical, measure))
}

/**
 * Where each character of `text` is, from the fitted runs it was laid out as: one cell per UTF-16
 * code unit (both halves of a surrogate pair share one), `null` for a line break. A cell is the
 * glyph's share of its run — its advance plus the spacing around it — and carries the run's index
 * as its `line`, so a word that wraps can be outlined a line at a time.
 *
 * This is how the controller's word cursor outlines the characters on the source itself, rather
 * than the overlay's own copy of them, which in word mode is drawn to suit hovering, not to match.
 */
export function characterCells(text, runs, vertical, measure) {
  const queue = []
  runs.forEach((run, line) => {
    const start = vertical ? run.rect.y : run.rect.x
    let advance = 0
    chars(run.text).forEach((character, index) => {
      const before = run.lead + run.fontSize * advance + run.spacing * index
      const size = run.fontSize * measure(character) + run.spacing
      const from = start + before - run.spacing / 2
      queue.push({
        character,
        line,
        x: vertical ? run.rect.x : from,
        y: vertical ? from : run.rect.y,
        width: vertical ? run.rect.width : size,
        height: vertical ? size : run.rect.height
      })
      advance += measure(character)
    })
  })
  const cells = []
  let next = 0
  for (const character of text) {
    const cell = character === '\n' ? null : (queue[next++] ?? null)
    for (let unit = 0; unit < character.length; unit++) cells.push(cell)
  }
  return cells
}

export default { layoutGroup, characterCells, fit, estimate, distribute, apportion, readingOrder }
