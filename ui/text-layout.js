/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Laying recognised text over the source so each character lands on the one it was read from.
 * Both overlay modes draw from here (`layoutParts`): word mode, where each box is hovered on its
 * own, and grouped mode, where nearby boxes share a card.
 *
 * The text is split into runs — a line, or a word on a line — and every run is placed in the
 * rectangle OCR found for it, then fitted to it: the glyph size from the run's thickness, the
 * space between characters so the run's ink starts and ends where the original's does, each glyph
 * where an evenly pitched line puts it. Japanese is set on a grid of near-equal cells, so a run
 * that starts and ends where the original does lines up all along. What is fitted is ink, not em
 * squares: OCR boxes the ink, and 「 or 。 sits well inside its own cell (see `fit`). The runs on
 * one visual row are then set at one size (`harmonize`), so a line reads uniformly however OCR
 * cut it into words.
 *
 * Runs come from the best evidence available, in order:
 *
 *   1. a box per line or per word (cloud OCR, MeikiOCR): each box is a run
 *   2. a box per paragraph or bubble with the lines found inside it (Google Lens, Live Text,
 *      OneOCR, Manga OCR): each line is a run, and a bubble's text, which may arrive unbroken, is
 *      shared out across its lines in proportion to their length
 *   3. a box per bubble and nothing more: the number of lines and the size that fill the box best
 *      are worked out, and the text is set as that many evenly spaced lines
 *
 * Pure: the caller supplies `measure`, the text's natural advance in ems (and, from a canvas, its
 * ink: see `inkOf`), so this runs in tests.
 */

/**
 * OCR's margin around the ink it boxes, per side, in ems: what engines leave, typically. An
 * engine whose own margins are known passes them with its boxes (`margin`; INK_MARGINS in
 * ocr-result.ts).
 */
export const PAD = 0.05
const MARGIN = [PAD, PAD, PAD, PAD]
/** How far into its em square a Japanese glyph's ink starts, where it cannot be measured. */
const EDGE = 0.06
/**
 * How much a run may be set larger than its own box allows to keep its row's size, against
 * that limit: past this its glyphs would overlap, and the box is wrong or the text misread.
 */
const OVERLAP = 1.15
/** Line pitch against glyph size, when the lines have to be guessed: typical game and manga leading. */
export const LEADING = 1.35
/**
 * A column thinner than this, against the block's glyph size, is ruby (furigana) and holds none of
 * the text: ruby is set at about half the size of the text it reads.
 */
const RUBY = 0.6
/**
 * A column thicker than this, against the block's glyph size, is two or more columns the detector
 * ran together, and says nothing about where one ends. One column with its ruby is about one and a
 * half glyphs, and the size fitted to the box reads small where two digits share one cell.
 */
const MERGED = 2.5
/**
 * How much of a block's length its found columns must run for a column the detector missed to be
 * taken as running the whole length too. Shorter, the block is not a rectangle of columns: two
 * bubbles or narration boxes whose outlines joined, one high on the right and one low on the left,
 * boxed as one. Nothing then says where a missed column ends, and stretching it over the full
 * length spaces its glyphs far apart; the box is set as wrapped text instead (`estimate`).
 */
const SPANNED = 0.75
/**
 * Glyph pitch against glyph size where nothing says where a line's glyphs are (`estimate`): set
 * solid, with the slight tracking manga and game text use, never spread out to fill the box.
 */
const PITCH = 1.05
/** Widest against narrowest of two regions that can be neighbouring columns (see `parallel`). */
const PARALLEL = 1.2
/**
 * Breadth, against the block's glyph size, of an uncovered strip that is taken for a missed column
 * in a block of joined bubbles: an ellipsis or a column of narrow kana is thinner than a full glyph.
 */
const OPEN = 0.8

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[(sorted.length - 1) >> 1] : 1
}

/**
 * The widest gap, in glyphs, between two runs set as one line by `harmonize`: wide enough for a
 * cloud engine's words spread across a menu line, narrower than the space between two bubbles.
 */
const ROW_GAP = 6

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
  const length = (rect) => (vertical ? rect.height : rect.width)
  const thick = (rect) => Math.max(1, vertical ? rect.width : rect.height)
  // A block's lines share a pitch, so each holds characters in proportion to its length. Their
  // breadths say little: ruby, kana and a slanted hand make lines of one size anywhere from three
  // quarters to one and a half times as broad as each other.
  const pitch = median(lines.filter((rect) => !rect.open).map(thick))
  const lengths = lines.map((rect) => (vertical && rect.extent != null ? rect.extent : length(rect)))
  // An open line (see `columns`) has no length of its own: it holds what the others have no room for.
  const open = lines.filter((rect) => rect.open).length
  if (open) {
    const known = lengths.reduce((sum, value, i) => sum + (lines[i].open ? 0 : value), 0)
    const rest = (Math.max(1, all.length - known / pitch) * pitch) / open
    lines.forEach((rect, i) => {
      if (rect.open) lengths[i] = rest
    })
  }
  // An open line's length is a guess, so it does not count at all.
  const weights = lines.map((rect) =>
    rect.open ? 0 : rect.guessed || thick(rect) > BROAD * pitch ? UNSURE : 1
  )
  const shares = breaks(all, lengths, weights)
  let at = 0
  return lines
    .map((rect, index) => {
      const piece = all.slice(at, at + shares[index]).join('')
      at += shares[index]
      if (!rect.open) return { text: piece, rect }
      // As long as its text set solid at the size its breadth allows, from the block's start.
      const bounds = { ...rect }
      delete bounds.open
      const span = Math.min(length(rect), chars(piece).length * thick(rect) * PITCH)
      return { text: piece, rect: vertical ? { ...bounds, height: span } : { ...bounds, width: span } }
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
/**
 * Where a block's lines break, from how long each is.
 *
 * The lines of one bubble share a pitch, so the breaks are chosen together: the counts that, at the
 * one pitch that best fits them, best explain every line's length (least squares, by dynamic
 * programming over the breaks, refitting the pitch until it settles). Rounding each break on its
 * own lets one line measured long — a short first column with ruby beside it, やっぱ — take a
 * character from the next. Japanese line breaking rules are kept: no line ends on an opening
 * bracket or begins with a closing mark or a pause (、。」…ー), and a break just after a pause is
 * slightly preferred, as lettering breaks there. Every line keeps at least one character.
 * Returns each line's share.
 */
function breaks(all, lengths, weights = lengths.map(() => 1)) {
  const n = all.length
  const lines = lengths.length
  if (!lines) return []
  const total = lengths.reduce((sum, value) => sum + Math.max(0, value), 0)
  if (total <= 0 || n < lines) return apportion(n, lengths)
  // The cells a line of `count` characters ending at `end` fills with ink: a final 。 or 、 sits at
  // the head of its cell, so the region the detector boxed stops well short of the cell's end.
  const cells = (count, end) => count - (SHORT_END.has(all[end - 1]) ? SHORT_END_CELLS : 0)
  const allowed = (cut) =>
    cut === n || (!OPENING.has(all[cut - 1]) && !NO_START.has(all[cut]))
  const pause = (cut) => BREAK_AFTER.has(all[cut - 1]) && !BREAK_AFTER.has(all[cut])
  // The best counts at one pitch, by dynamic programming over the breaks.
  const at = (pitch) => {
    // cost[i][c]: the best cost of setting the first c characters as the first i lines.
    const cost = Array.from({ length: lines + 1 }, () => new Array(n + 1).fill(Infinity))
    const from = Array.from({ length: lines + 1 }, () => new Array(n + 1).fill(-1))
    cost[0][0] = 0
    for (let i = 1; i <= lines; i++)
      for (let c = i; c <= n - (lines - i); c++) {
        if (i < lines ? !allowed(c) : c !== n) continue
        const bonus = i < lines && pause(c) ? PAUSE_PREFERENCE * pitch * pitch : 0
        // Latest break first, so of two equally good the earlier lines are the fuller, as they fill.
        for (let b = c - 1; b >= i - 1; b--) {
          const miss = lengths[i - 1] - cells(c - b, c) * pitch
          // Longer lines only miss by more from here: a measured line twice overfilled is done.
          if (weights[i - 1] > 0 && miss < -(lengths[i - 1] + 2 * pitch)) break
          if (cost[i - 1][b] === Infinity) continue
          const value = cost[i - 1][b] + weights[i - 1] * miss * miss - bonus
          if (value < cost[i][c]) {
            cost[i][c] = value
            from[i][c] = b
          }
        }
      }
    if (cost[lines][n] === Infinity) return null
    const counts = new Array(lines)
    for (let i = lines, c = n; i > 0; c = from[i][c], i--) counts[i - 1] = c - from[i][c]
    return counts
  }
  const average = total / n
  // Their cost at the pitch that fits them best, so counts found at different pitches compare.
  const score = (counts) => {
    let end = 0
    const filled = counts.map((count) => cells(count, (end += count)))
    const fitted =
      filled.reduce((sum, count, i) => sum + weights[i] * count * lengths[i], 0) /
      Math.max(1e-9, filled.reduce((sum, count, i) => sum + weights[i] * count * count, 0))
    const pitch = Math.min(average * 1.3, Math.max(average * 0.7, fitted))
    let breaksAt = 0
    return counts.reduce((sum, count, i) => {
      breaksAt += count
      const miss = lengths[i] - filled[i] * pitch
      const bonus = i < lines - 1 && pause(breaksAt) ? PAUSE_PREFERENCE * pitch * pitch : 0
      return sum + weights[i] * miss * miss - bonus
    }, 0)
  }
  // The pitch is unknown, and one count found too long or short moves it: every pitch from well
  // under to well over the average is tried, and the counts that fit best at their own pitch win.
  let shares = null
  let best = Infinity
  for (let step = 0; step <= PITCH_STEPS; step++) {
    const counts = at(average * (0.7 + (0.6 * step) / PITCH_STEPS))
    if (!counts) continue
    const value = score(counts)
    if (value < best) {
      best = value
      shares = counts
    }
  }
  // Only text no rule allows to break at all gets the plain proportions.
  return shares ?? apportion(n, lengths)
}

/** Marks whose ink sits at the head of their cell in a column, and how much of it they leave blank. */
const SHORT_END = new Set([...'。、．，'])
const SHORT_END_CELLS = 0.6
/**
 * A line region this much broader than its block's usual one has taken in a neighbour's ruby,
 * which runs on past its own text: its length counts for little (UNSURE) in setting the breaks.
 */
const BROAD = 1.3
const UNSURE = 0.25

/** Pitches tried, from 0.7 to 1.3 times a block's average, when setting where its lines break. */
const PITCH_STEPS = 48

/** How much a break just after a pause is preferred, in squared pitches of length error. */
const PAUSE_PREFERENCE = 0.25

/** What a Japanese line does not begin with: closing marks, pauses, the prolonged sound mark. */
const NO_START = new Set([...'、。，．・…‥！？!?」』）)〕】〉》ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ～'])

/** Opening brackets: a line never ends on one. */
const OPENING = new Set([...'「『（(〔【〈《'])

/** A run of nothing but ellipses (or dots for them): not a lone 。 or 、, which is fitted as ink. */
const DOTS = /^(?:[…‥]+|[．.・]{2,})$/u

/** Punctuation a line of manga or game text usually ends after: a pause, a stop, a closing mark. */
const BREAK_AFTER = new Set([...'、。，．・…‥！？!?」』）)〕】'])

/**
 * Characters as `lines` lines of at most `perLine`, broken where the text pauses when it can be.
 *
 * Each line ends after the last pause (BREAK_AFTER, at the end of a run of them, so ．．． stays
 * whole) that leaves the rest room in the lines after it; without one, the line is filled to the
 * edge, as wrapped text is. Manga letters a bubble's columns that way — 「……」 then 「嘘だろ…？」, not
 * 「……嘘だろ…」 then 「？」 — and so do most game text boxes.
 */
function wrap(all, perLine, lines) {
  const rows = []
  let at = 0
  while (at < all.length) {
    const left = Math.max(1, lines - rows.length - 1)
    let end = Math.min(all.length, at + perLine)
    if (end < all.length) {
      for (let cut = end; cut > at; cut--) {
        const pause = BREAK_AFTER.has(all[cut - 1]) && !BREAK_AFTER.has(all[cut])
        if (pause && all.length - cut <= left * perLine) {
          end = cut
          break
        }
      }
    }
    rows.push(all.slice(at, end).join(''))
    at = end
  }
  return rows
}

/** The number of lines, and their glyph size, that set `count` characters largest in a box. */
function bestFit(count, along, across) {
  let best = { size: 0, lines: 1 }
  for (let lines = 1; lines <= Math.max(1, count); lines++) {
    const perLine = Math.ceil(count / lines)
    const size = Math.min(along / perLine, across / (lines + (lines - 1) * (LEADING - 1)))
    if (size > best.size) best = { size, lines }
  }
  return best
}

export function estimate(text, rect, vertical) {
  const along = vertical ? rect.height : rect.width
  const across = vertical ? rect.width : rect.height
  const explicit = text.split('\n')
  let rows
  if (explicit.length > 1) {
    rows = explicit
  } else {
    const all = chars(text)
    const best = bestFit(all.length, along, across)
    // Wrapped text fills every line to the edge and leaves the remainder on the last, so a
    // line holds as many cells of the chosen size as fit, not an even share of the text.
    const perLine = Math.max(
      Math.ceil(all.length / best.lines),
      Math.floor(along / (best.size * PITCH) + 1e-6)
    )
    rows = wrap(all, perLine, best.lines)
  }
  const longest = Math.max(1, ...rows.map((row) => chars(row).length))
  const size = Math.min(along / longest, across / (rows.length + (rows.length - 1) * (LEADING - 1)))
  const pitch = rows.length > 1 ? (across - size) / (rows.length - 1) : 0
  // Lines start at the box's edge at their natural pitch; one a box's breadth limits is not spread
  // along its length, where a box drawn around two joined bubbles has room for none of it.
  const cell = Math.min(along / longest, size * PITCH)
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
 * A vertical block's columns, from the lines a manga text detector found in it, or null when they
 * cannot be trusted to say where the text is.
 *
 * Manga OCR's detector reports line regions, not lines: a column of ruby beside the text, one
 * column in two or three pieces, two columns run together. Shared out as lines (`distribute`),
 * the text lands on the ruby at a third of its size and the rest spreads over a run-together pair.
 * So, against the size the block's text would be set at in its box (`bestFit`): ruby-thin regions
 * are dropped (RUBY), regions that overlap across by more than half the thinner one are one column
 * (their union, with the words on both) unless they are slanted neighbours (`parallel`). A column still thicker than MERGED glyphs, or fewer
 * columns than the box holds, means the detector could not separate them, which leaves only the
 * box to go by (`estimate`); so does a missed column in a block its found columns do not span
 * (SPANNED).
 */
/** How far two columns' spans along overlap. */
const shared = (a, b) => Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/**
 * Whether two overlapping regions are neighbouring columns of slanted handwriting rather than one
 * column found in pieces, or two run together: boxed around their slant, such columns come out
 * about twice as wide as their glyphs and overlap as much as pieces do, but they are as wide as each
 * other (PARALLEL) and lie a glyph apart. A region that holds a neighbour's column as well is the
 * wider one.
 */
function parallel(a, b, size) {
  const apart = Math.abs(a.x + a.width / 2 - (b.x + b.width / 2))
  return apart >= size / 2 && Math.max(a.width, b.width) <= PARALLEL * Math.min(a.width, b.width)
}

export function columns(lines, text, rect) {
  const count = chars(text.replace(/\n/g, '')).length
  const best = bestFit(count, rect.height, rect.width)
  // No larger than the widest region found: a bubble's box takes in blank around sparse text
  // (……／かう), and sized by that, the dots' own column would read as ruby.
  const size = Math.min(best.size, Math.max(...lines.map((line) => line.width)))
  const expected = best.lines
  if (!(size > 0)) return null
  const merged = []
  for (const line of lines.filter((line) => line.width >= RUBY * size)) {
    let column = { ...line, segments: [...(line.segments ?? [])] }
    for (let joined = true; joined; ) {
      joined = false
      for (let i = 0; i < merged.length; i++) {
        const other = merged[i]
        const overlap =
          Math.min(column.x + column.width, other.x + other.width) - Math.max(column.x, other.x)
        if (overlap <= Math.min(column.width, other.width) / 2 || parallel(column, other, size)) continue
        const x = Math.min(column.x, other.x)
        const y = Math.min(column.y, other.y)
        column = {
          x,
          y,
          width: Math.max(column.x + column.width, other.x + other.width) - x,
          height: Math.max(column.y + column.height, other.y + other.height) - y,
          segments: [...other.segments, ...column.segments].sort((a, b) => a.y - b.y),
          // Length the text runs: the pieces', not the blank between them (あぁ… over オタク).
          extent: (column.extent ?? column.height) + (other.extent ?? other.height) - shared(column, other)
        }
        merged.splice(i, 1)
        joined = true
        break
      }
    }
    merged.push(column)
  }
  if (!merged.length || merged.some((column) => column.width > MERGED * size)) return null
  // A stretch of the box as wide as a glyph that no column covers is a column the detector missed
  // (the box is the text's, so something is there): it runs the box's full length.
  //
  // In a block its found columns do not span (SPANNED: two joined bubbles), nothing says how long a
  // missed column is, so it is left `open`: it takes the text the found columns have no room for,
  // set from the block's start at its natural pitch (`distribute`). A narrower strip counts there,
  // since the box was not fitted to a rectangle of columns.
  const longest = Math.max(...merged.map((column) => column.height))
  const joined = longest < SPANNED * rect.height
  const covered = [...merged].sort((a, b) => a.x - b.x)
  const missed = []
  let edge = rect.x
  const ends = [covered[0], covered[covered.length - 1]]
  for (const column of [...covered, { x: rect.x + rect.width, width: 0 }]) {
    // Between two found columns of joined bubbles lies blank bubble, not a missed column: one the
    // detector missed there is at an edge of the box, beside the columns it did find.
    const edgeward = !joined || column === ends[0] || column.x === rect.x + rect.width
    if (edgeward && column.x - edge >= (joined ? OPEN : 1) * size)
      missed.push({
        x: edge,
        y: rect.y,
        width: column.x - edge,
        height: rect.height,
        segments: [],
        // Its length is the block's, not its own: open in joined bubbles, guessed in a rectangle.
        ...(joined ? { open: true } : { guessed: true })
      })
    edge = Math.max(edge, column.x + column.width)
  }
  const found = [...merged, ...missed]
  // A joined block's box says too little about how many columns it holds to doubt the ones found.
  return joined || found.length >= expected ? found : null
}

/**
 * What a run's ink looks like in the font it is drawn in, in ems at zero letter spacing:
 * `advance` (its natural length), where along it the ink `start`s and `end`s, and, across it,
 * the ink's height above and below the baseline (`ascent`, `descent`) against the font's own
 * (`fontAscent`, `fontDescent`), which is what CSS centres in a line box.
 *
 * `measure(text)` is the natural advance; `measure.ink(text)`, when there is a canvas, measures
 * the rest on the real glyphs. Without it, and for vertical text (which a canvas cannot set), a
 * Japanese glyph is taken to fill its em square a little inside every edge.
 */
export function inkOf(text, measure, vertical = false) {
  const measured = !vertical && measure.ink ? measure.ink(text) : null
  if (measured) return measured
  const advance = Math.max(0.01, measure(text))
  return {
    advance,
    start: Math.min(EDGE, advance / 4),
    end: Math.max(advance - EDGE, (advance * 3) / 4),
    ascent: 0.84,
    descent: 0.08,
    fontAscent: 0.88,
    fontDescent: 0.12
  }
}

/** The ink's thickness across the run, in ems: its height, or a column's width. */
const thickness = (ink, vertical) => (vertical ? 1 - 2 * EDGE : ink.ascent + ink.descent)

/**
 * Fit one run into its rectangle, the ink of the drawn text over the ink OCR boxed.
 *
 * OCR boxes ink, with a small margin (PAD) on every side, not the glyphs' em squares, so it is the
 * drawn ink that is fitted: the glyph size is the one whose ink fills the box across, or, if that
 * would overrun it, along (where text without tracking is as tight as it can be). The leftover
 * length becomes letter spacing, and `lead` places the first glyph so its ink starts at the box's
 * start; the last glyph's ink then ends at the box's end, and every glyph between sits where an
 * evenly pitched line puts it. `lead` may be negative: 「 starts half an em before its ink. Across,
 * `shift` moves the line from where CSS centres the font's em box to where the ink is centred.
 *
 * `size`, when given, is the size this run's visual row is set at (see `harmonize`); it is
 * honoured unless the run would then have to overlap its glyphs by more than OVERLAP allows.
 * `natural` is the size the run would have on its own.
 */
export function fit(run, vertical, measure, size = null) {
  const { rect, text } = run
  const count = Math.max(1, chars(text).length)
  const along = vertical ? rect.height : rect.width
  const across = vertical ? rect.width : rect.height
  // The engine's margins around the ink: at the start and end of the run, and before and after
  // it across (above and below; right and left of a column).
  const [start, end, before, after] = run.margin?.length === 4 ? run.margin : MARGIN
  const ink = inkOf(text, measure, vertical)
  const span = Math.max(0.05, ink.end - ink.start)
  const byAcross = across / (thickness(ink, vertical) + before + after)
  const byAlong = along / (span + start + end)
  const natural = Math.max(1, Math.min(byAcross, byAlong))
  // The engine's words or characters, where it gave them, place the glyphs better than the ends
  // of the line alone: one glyph whose ink sits differently in this font cannot shift the rest.
  // Placed so, a run takes its row's size as it is; placed by its ends, only while its glyphs
  // would not overlap more than OVERLAP allows.
  let fontSize = Math.max(1, size ?? natural)
  // A run of dots alone (…… on its own column) is boxed tight around ink that is mostly blank: it
  // keeps its row's size, set solid and centred on its box, rather than shrinking to fit it.
  if (size && DOTS.test(text)) {
    const length = measure(text) * fontSize
    return { ...run, fontSize, spacing: 0, lead: (along - length) / 2, shift: 0, natural }
  }
  const placed = bySegments(run, vertical, measure, fontSize, start, end)
  if (!placed && size) fontSize = Math.max(1, Math.min(size, byAlong * OVERLAP))
  const room = along - (start + end + span) * fontSize
  const spacing = placed ? placed.spacing : count > 1 ? room / (count - 1) : 0
  const lead = placed ? placed.lead : (start - ink.start) * fontSize + (count > 1 ? 0 : room / 2)
  // Across, in px along the page's own axis (down for a line, right for a column): from where
  // CSS centres the em box to where the ink is centred between the engine's margins.
  const centring = vertical
    ? 0
    : (ink.fontAscent - ink.fontDescent - (ink.ascent - ink.descent)) / 2
  const shift = (vertical ? after - before : before - after) * (fontSize / 2) - centring * fontSize
  return { ...run, fontSize, spacing, lead, shift, natural }
}

/**
 * Where the glyphs go when the engine boxed the run's words or characters (`run.segments`, each
 * with the index of its first character, `at`): the first glyph's origin (`lead`, from the run's
 * start) and the letter spacing that best put every segment's drawn ink where its box says, by
 * least squares over both ends of every segment, refitted once without the worst misfits (a box
 * around a misread glyph, a stray mark). Null when the segments cannot say (one glyph's worth),
 * or say something implausible.
 */
function bySegments(run, vertical, measure, fontSize, startMargin, endMargin) {
  const segments = run.segments
  if (!segments?.length) return null
  const all = chars(run.text)
  const points = []
  for (const segment of segments) {
    const count = chars(segment.text).length
    if (!count || segment.at + count > all.length) return null
    const before = measure(all.slice(0, segment.at).join(''))
    const ink = inkOf(segment.text, measure, vertical)
    const from = vertical ? segment.y : segment.x
    const to = from + (vertical ? segment.height : segment.width)
    // origin of the first glyph + spacing × glyphs before = where this edge says it is
    points.push([segment.at, from + (startMargin - before - ink.start) * fontSize])
    points.push([segment.at + count - 1, to - (endMargin + before + ink.end) * fontSize])
  }
  const solve = (used) => {
    const n = used.length
    const mk = used.reduce((sum, [k]) => sum + k, 0) / n
    const mv = used.reduce((sum, [, v]) => sum + v, 0) / n
    const skk = used.reduce((sum, [k]) => sum + (k - mk) ** 2, 0)
    if (skk <= 0) return null
    const spacing = used.reduce((sum, [k, v]) => sum + (k - mk) * (v - mv), 0) / skk
    return { origin: mv - spacing * mk, spacing }
  }
  let line = solve(points)
  if (!line) return null
  const misfit = points.map(([k, v]) => Math.abs(line.origin + line.spacing * k - v))
  const typical = [...misfit].sort((a, b) => a - b)[misfit.length >> 1]
  const kept = points.filter((_, i) => misfit[i] <= Math.max(2.5 * typical, 0.05 * fontSize))
  line = (kept.length < points.length && solve(kept)) || line
  if (line.spacing < -0.3 * fontSize || line.spacing > 3 * fontSize) return null
  return { lead: line.origin - (vertical ? run.rect.y : run.rect.x), spacing: line.spacing }
}

/**
 * One size per visual row. Runs whose centres lie on one line (within half a glyph across, and of
 * comparable size) are a row, set at the median of its runs' own sizes, read from the runs of
 * more than one character when there are any: a lone 、 or ー boxes too little ink to size a line
 * by. The columns of one vertical block (`block`, the part they came from) are one row however far
 * apart they lie: a bubble is lettered at one size. Returns the size for each run, in order.
 *
 * @param {{text: string, rect: {x: number, y: number, width: number, height: number}, vertical?: boolean, block?: number, natural: number}[]} runs
 */
export function harmonize(runs) {
  const parent = runs.map((_, index) => index)
  const root = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const centre = (run) =>
    run.vertical ? run.rect.x + run.rect.width / 2 : run.rect.y + run.rect.height / 2
  // How far apart two runs are along their line: one line cut into words has gaps of a glyph or
  // two at most, while two bubbles that merely share a height (or, in columns, a left edge) are far
  // apart, and averaging their sizes shrank a big word to a small one's size, its glyphs spaced
  // out to fill its box (キルコ嬢 set at a caption's size because the caption ran below it).
  const gap = (a, b) => {
    const [from, length] = a.vertical ? ['y', 'height'] : ['x', 'width']
    return Math.max(a.rect[from], b.rect[from]) - Math.min(a.rect[from] + a.rect[length], b.rect[from] + b.rect[length])
  }
  const together = (a, b) => {
    if (!!a.vertical !== !!b.vertical || DOTS.test(a.text) || DOTS.test(b.text)) return false
    const large = Math.max(a.natural, b.natural)
    return (
      large <= Math.min(a.natural, b.natural) * 2 &&
      Math.abs(centre(a) - centre(b)) < large / 2 &&
      gap(a, b) < ROW_GAP * large
    )
  }
  // Runs of several characters make the rows; a lone character only joins one (the nearest it
  // fits), so a 、 whose little ink reads large cannot bridge a line and a heading beside it.
  const lone = runs.map((run) => chars(run.text).length < 2)
  // For each lone character, the nearest run of several it fits with, if any.
  const host = runs.map((run, i) => {
    if (!lone[i]) return -1
    let best = -1
    runs.forEach((other, j) => {
      if (lone[j] || !together(run, other)) return
      if (best < 0 || Math.abs(centre(other) - centre(run)) < Math.abs(centre(runs[best]) - centre(run)))
        best = j
    })
    return best
  })
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++)
      if (lone[i] === lone[j] && host[i] < 0 && host[j] < 0 && together(runs[i], runs[j]))
        parent[root(j)] = root(i)
  host.forEach((best, i) => {
    if (best >= 0) parent[i] = root(best)
  })
  const block = new Map()
  runs.forEach((run, i) => {
    if (run.block == null) return
    if (block.has(run.block)) parent[root(i)] = root(block.get(run.block))
    else block.set(run.block, i)
  })
  const rows = new Map()
  runs.forEach((run, index) => {
    const key = root(index)
    if (!rows.has(key)) rows.set(key, [])
    rows.get(key).push(run)
  })
  const sizeOf = new Map()
  for (const [key, members] of rows) {
    // A run of ellipses is boxed around little ink and measures large: it takes the size, never sets it.
    const long = members.filter((run) => chars(run.text).length > 1 && !DOTS.test(run.text))
    const sizes = (long.length ? long : members).map((run) => run.natural).sort((a, b) => a - b)
    const middle = sizes.length >> 1
    sizeOf.set(key, sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2)
  }
  return runs.map((_, index) => sizeOf.get(root(index)))
}

/**
 * A line cut where OCR's own words (or characters) show a gap: a space the engine left out of
 * the text, or a column of a menu. Without the cut the rest of the line would be spaced evenly
 * across the gap and drift a whole glyph or more. The segments' texts are found in the line's
 * text in order (what lies between them, a separator, stays with the piece before); a gap is one
 * wider than the line's usual gap by more than half its thickness. Each piece keeps the line's
 * extent across, runs along over its own segments, and carries them, each with the index of the
 * character it starts at (`at`), for `fit` to place its glyphs by. Anything that does not match
 * is drawn as the one line it came as.
 *
 * @param {{text: string, rect: {x: number, y: number, width: number, height: number}}} run
 * @param {{text: string, x: number, y: number, width: number, height: number}[]} segments
 */
export function splitAtGaps(run, segments, vertical, measure = null) {
  if (!segments?.length) return [run]
  const found = []
  let at = 0
  for (const segment of segments) {
    const index = segment.text ? run.text.indexOf(segment.text, at) : -1
    if (index < 0) return [run]
    found.push(index)
    at = index + segment.text.length
  }
  const from = (s) => (vertical ? s.y : s.x)
  const to = (s) => (vertical ? s.y + s.height : s.x + s.width)
  const thick = vertical ? run.rect.width : run.rect.height
  // The blank a glyph's own shape leaves (、 and 」 sit at the start of their cells) is no gap:
  // measured against the drawn font, at about the line's size, it is taken off first.
  const blank = (i) => {
    if (!measure) return 0
    const here = inkOf(segments[i].text, measure, vertical)
    const next = inkOf(segments[i + 1].text, measure, vertical)
    return (here.advance - here.end + next.start) * thick
  }
  const gaps = segments.slice(1).map((segment, i) => from(segment) - to(segments[i]) - blank(i))
  const usual = gaps.length ? [...gaps].sort((a, b) => a - b)[(gaps.length - 1) >> 1] : 0
  const cuts = [0]
  gaps.forEach((gap, i) => {
    if (gap > Math.max(0, usual) + thick / 2) cuts.push(i + 1)
  })
  cuts.push(segments.length)
  const pieces = []
  for (let c = 0; c + 1 < cuts.length; c++) {
    const members = segments.slice(cuts[c], cuts[c + 1])
    // Text before the first segment belongs to the first piece; a separator, to the one before.
    const begin = c === 0 ? 0 : found[cuts[c]]
    const end = cuts[c + 1] < segments.length ? found[cuts[c + 1]] : run.text.length
    const text = run.text.slice(begin, end)
    if (!text) continue
    const lo = Math.min(...members.map(from))
    const hi = Math.max(...members.map(to))
    pieces.push({
      text,
      rect:
        cuts.length === 2
          ? run.rect
          : vertical
            ? { x: run.rect.x, y: lo, width: run.rect.width, height: hi - lo }
            : { x: lo, y: run.rect.y, width: hi - lo, height: run.rect.height },
      segments: members.map((segment, k) => ({
        ...segment,
        at: chars(run.text.slice(begin, found[cuts[c] + k])).length
      }))
    })
  }
  return pieces.length ? pieces : [run]
}

/**
 * Estimated columns moved down to start where a column the detector did find starts, when one lies
 * under them: in a box around two joined bubbles the lower one's text begins well below the box's
 * top, and the detector usually found that much. Kept inside the box.
 */
function anchored(runs, found, rect, vertical) {
  if (!vertical || !found.length) return runs
  return runs.map((run) => {
    const { x, width, height } = run.rect
    const under = found.find(
      (line) => Math.min(x + width, line.x + line.width) - Math.max(x, line.x) > width / 2
    )
    if (!under) return run
    const y = Math.max(rect.y, Math.min(under.y, rect.y + rect.height - height))
    return { ...run, rect: { ...run.rect, y } }
  })
}

/**
 * The runs one part is drawn as: itself, or a block's lines (found, or estimated), each cut where
 * the engine's words show a gap (`splitAtGaps`), all with the engine's ink margins.
 */
export function splitPart(part, vertical, measure = null) {
  if (!part.text) return []
  let runs
  if (part.block || part.text.includes('\n')) {
    // The words found on each line travel with it through the reading-order sort.
    const found = (part.lines ?? []).map((line, index) => ({
      ...line,
      segments: part.lineSegments?.[index] ?? []
    }))
    const lines = vertical && found.length ? columns(found, part.text, part.rect) : found
    if (lines?.length) {
      runs = distribute(part.text, lines, vertical).flatMap(({ text, rect }) => {
        const { segments, ...bounds } = rect
        delete bounds.extent
        delete bounds.guessed
        return splitAtGaps({ text, rect: bounds }, segments, vertical, measure)
      })
    } else runs = anchored(estimate(part.text, part.rect, vertical), found, part.rect, vertical)
  } else runs = splitAtGaps({ text: part.text, rect: part.rect }, part.segments, vertical, measure)
  return part.margin ? runs.map((run) => ({ ...run, margin: part.margin })) : runs
}

/**
 * Everything on screen, fitted together: each part's runs, in order, with the runs on one
 * visual row set at one size. The one fitting routine both overlay modes draw from.
 *
 * @param {{text: string, rect: {x: number, y: number, width: number, height: number}, lines?: {x: number, y: number, width: number, height: number}[], lineSegments?: object[][], segments?: object[], margin?: number[], block?: boolean, vertical?: boolean}[]} parts
 *   in overlay coordinates: a block carries the line rectangles found inside it, if any, and the
 *   words found on each (`lineSegments`); a line, the words or characters on it (`segments`);
 *   any part, its engine's ink margins (`margin`, see `fit`), and the measure of its own typeface
 *   (`measure`), when it is not set in the overlay's
 * @param {(text: string) => number} measure the natural advance in ems; see `inkOf` for `.ink`
 */
export function layoutParts(parts, measure) {
  // A part set in a typeface of its own measures in it (`part.measure`); the rest in `measure`.
  const measureOf = (index) => parts[index].measure ?? measure
  const pieces = parts.map((part, index) =>
    splitPart(part, !!part.vertical, measureOf(index)).map((run) => ({ ...run, vertical: !!part.vertical }))
  )
  const sizes = harmonize(
    pieces.flatMap((runs, index) => {
      const part = parts[index]
      const block = part.vertical && (part.block || part.text.includes('\n')) ? index : undefined
      return runs.map((run) => ({ ...fit(run, run.vertical, measureOf(index)), block }))
    })
  )
  let next = 0
  return pieces.map((runs, index) =>
    runs.map((run) => fit(run, run.vertical, measureOf(index), sizes[next++]))
  )
}

/**
 * Every run of one group, fitted: `layoutParts` for parts that share an orientation, flattened.
 *
 * @param {{text: string, rect: {x: number, y: number, width: number, height: number}, lines?: {x: number, y: number, width: number, height: number}[], block?: boolean}[]} parts
 * @param {boolean} vertical
 * @param {(text: string) => number} measure
 */
export function layoutGroup(parts, vertical, measure) {
  return layoutParts(
    parts.map((part) => ({ ...part, vertical })),
    measure
  ).flat()
}

/**
 * Where each character of `text` is, from the fitted runs it was laid out as: one cell per UTF-16
 * code unit (both halves of a surrogate pair share one), `null` for a line break. A cell is the
 * glyph's share of its run — its advance plus the spacing around it — and carries the run's index
 * as its `line`, so a word that wraps can be outlined a line at a time.
 *
 * This is how the controller's word cursor outlines a word-mode box's characters, from the same
 * runs the box's text is drawn with (the drawn text itself is hidden until hovered).
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

export default {
  layoutParts,
  layoutGroup,
  characterCells,
  fit,
  harmonize,
  inkOf,
  splitAtGaps,
  splitPart,
  estimate,
  distribute,
  apportion,
  readingOrder
}
