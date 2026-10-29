/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Stepping through the last scan's text one word at a time.
 *
 * OCR gives text by the box or bubble, never by the word, so the words are found here. The
 * best splitter is the dictionary itself: Yomitan's own scanning parser (`parseText`) walks
 * the text taking the longest dictionary match at each position, with deinflection, which is
 * exactly the span a lookup at that position would show. Text it cannot match is left as a
 * gap. Without a dictionary to ask, the platform's word segmenter (`Intl.Segmenter`, ICU's
 * dictionary-based Japanese breaker) stands in.
 *
 * The cursor works over every box of the scan in reading order. Within a box a line is a line
 * of horizontal text or a column of vertical text, and moving to the next or previous line
 * keeps the reader's place along it rather than jumping to its start.
 */

const JAPANESE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ々〆ヵヶー]/u
/** The longest stretch the parser compares against the dictionary at each position. */
export const SCAN_LENGTH = 16

/** True for text worth stopping on: it holds a letter or digit, not only punctuation. */
export function isWordText(text) {
  return /[\p{L}\p{N}]/u.test(text)
}

/**
 * Tokens from a Yomitan `parseText` scanning-parser result, with their offsets in `text`.
 * Each token is a list of furigana segments; a dictionary match carries `headwords` on its
 * first segment, and runs of unmatched characters arrive as one segment without them.
 */
export function tokensFromParse(text, content) {
  const tokens = []
  let offset = 0
  for (const token of content ?? []) {
    const value = (token ?? []).map((segment) => segment?.text ?? '').join('')
    if (!value) continue
    const start = text.indexOf(value, offset)
    if (start < 0) break
    const end = start + value.length
    const matched = Array.isArray(token[0]?.headwords)
    tokens.push({ start, end, text: value, word: matched && isWordText(value) })
    offset = end
  }
  return tokens
}

/**
 * Tokens from Hachidori's `hd_segment` spans (`{start, length}` in `text`): each span is the
 * word a lookup there matches; text between spans is a gap the reader does not stop on.
 */
export function tokensFromSpans(text, spans) {
  const tokens = []
  let offset = 0
  const ordered = [...(spans ?? [])]
    .filter((span) => Number.isInteger(span?.start) && Number.isInteger(span?.length) && span.length > 0)
    .sort((a, b) => a.start - b.start)
  for (const { start, length } of ordered) {
    if (start < offset || start + length > text.length) continue
    if (start > offset) tokens.push({ start: offset, end: start, text: text.slice(offset, start), word: false })
    const value = text.slice(start, start + length)
    tokens.push({ start, end: start + length, text: value, word: isWordText(value) })
    offset = start + length
  }
  if (offset < text.length) tokens.push({ start: offset, end: text.length, text: text.slice(offset), word: false })
  return tokens
}

/** Tokens from the platform's word segmenter, when there is no dictionary to ask. */
export function tokensFromSegmenter(text, Segmenter = globalThis.Intl?.Segmenter) {
  if (!Segmenter) {
    // No segmenter at all: one character at a time is crude, but every character is reachable.
    return [...text].reduce((tokens, character) => {
      const start = tokens.length ? tokens[tokens.length - 1].end : 0
      tokens.push({
        start,
        end: start + character.length,
        text: character,
        word: isWordText(character)
      })
      return tokens
    }, [])
  }
  const segmenter = new Segmenter('ja', { granularity: 'word' })
  const segments = (piece, offset) =>
    [...segmenter.segment(piece)].map(({ segment, index, isWordLike }) => ({
      start: offset + index,
      end: offset + index + segment.length,
      text: segment,
      word: Boolean(isWordLike) && isWordText(segment)
    }))
  // ICU's breaker cuts inflected words to pieces (作|っ|た, 食|べ|ま|した), and a stop on 作 alone
  // highlights and looks up the kanji instead of the verb. So kanji keep the kana that follow them
  // (okurigana and inflection: 作った, 食べました); a long run of kana after them is more than
  // that, and only its first piece joins. Kana that follow no kanji, and everything else, are
  // split by ICU as before.
  const tokens = []
  const run = (from, test) => {
    let to = from
    while (to < text.length && test(text[to])) to++
    return to
  }
  let at = 0
  while (at < text.length) {
    if (!KANJI.test(text[at])) {
      const next = run(at, (c) => !KANJI.test(c))
      tokens.push(...segments(text.slice(at, next), at))
      at = next
      continue
    }
    let end = run(at, (c) => KANJI.test(c))
    const kana = run(end, (c) => HIRAGANA.test(c))
    if (kana > end && !PARTICLE_START.test(text[end])) {
      if (kana - end <= OKURIGANA_MAX) end = kana
      else end = segments(text.slice(end, kana), end)[0]?.end ?? end
    }
    tokens.push({ start: at, end, text: text.slice(at, end), word: true })
    at = end
    // What follows the chunk in the same kana run is split by ICU.
    const rest = run(at, (c) => HIRAGANA.test(c))
    if (rest > at) {
      tokens.push(...segments(text.slice(at, rest), at))
      at = rest
    }
  }
  return tokens
}

const KANJI = /[\p{Script=Han}々〆ヶ]/u
const HIRAGANA = /\p{Script=Hiragana}/u
/** The longest run of kana after kanji taken whole as its okurigana and inflection (食べさせられた). */
const OKURIGANA_MAX = 6
/** Kana that start a particle after a noun, never a verb's ending: 剣を, 刀の, 国が. */
const PARTICLE_START = /[をのがへはや]/

/**
 * Split `text` into tokens, asking `parse` first: Yomitan's `parseText` results, or
 * `{ spans }` from Hachidori's `hd_segment` (`tokensFromSpans`).
 *
 * A parse that matches nothing in Japanese text means there is no usable dictionary — none
 * installed, or lookups served by another app — so the segmenter's answer is better than a
 * box with no stops in it.
 */
export async function segmentText(text, parse) {
  if (!text) return []
  if (parse) {
    try {
      const results = await parse(text)
      const tokens = Array.isArray(results?.spans)
        ? tokensFromSpans(text, results.spans)
        : tokensFromParse(text, (results ?? []).find((result) => result?.source === 'scanning-parser')?.content)
      if (tokens.some((token) => token.word) || !JAPANESE.test(text)) return tokens
    } catch {
      // Fall through to the segmenter: a backend that is not ready yet must not leave the
      // reader with nothing to step through.
    }
  }
  return tokensFromSegmenter(text)
}

/**
 * The boxes a reader steps through, in reading order.
 *
 * Only boxes with Japanese in them: the Log is written on the same rule (`isJapanese` in
 * scene.ts), so background patterns OCR reads as symbols or digits (a carpet's squares) are
 * neither published nor stopped on. And in reading order by where each box is, not in the order
 * OCR listed them: horizontal text in rows from the top, left to right; vertical text in columns
 * from the right, top to bottom. `vertical` is the scan's direction (see `dominantVertical`).
 *
 * @template {{text: string, box?: {x: number, y: number, width: number, height: number}}} U
 * @param {U[]} units
 * @param {boolean} vertical
 * @returns {U[]}
 */
export function readingUnits(units, vertical) {
  const kept = units.filter((unit) => JAPANESE.test(unit.text))
  if (!kept.every((unit) => unit.box)) return kept
  return kept
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => {
      const p = a.unit.box
      const q = b.unit.box
      // Boxes that share a row (a column) are side by side; otherwise one comes first.
      if (vertical) {
        const overlap = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x)
        if (overlap > Math.min(p.width, q.width) * 0.5) return p.y - q.y || a.index - b.index
        return q.x + q.width - (p.x + p.width) || a.index - b.index
      }
      const overlap = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y)
      if (overlap > Math.min(p.height, q.height) * 0.5) return p.x - q.x || a.index - b.index
      return p.y - q.y || a.index - b.index
    })
    .map(({ unit }) => unit)
}

/**
 * Whether the scan as a whole runs vertically: the direction most of its characters run in.
 * One direction for all of it, so the arrow keys mean the same on every word; a stray box read
 * the other way (a lone glyph is as tall as it is wide) cannot turn "next" into "back".
 */
export function dominantVertical(units) {
  let vertical = 0
  let horizontal = 0
  for (const unit of units) {
    const length = [...unit.text].length
    if (unit.vertical) vertical += length
    else horizontal += length
  }
  return vertical > horizontal
}

/**
 * Each unit's tokens, found with the text after it in reading order, so a word OCR split across
 * two boxes is found whole: its token starts in one unit and ends past it, and the next unit's
 * text it covers is no stop of its own.
 *
 * @param {{text: string}[]} units in reading order
 * @param {(text: string) => Promise<{start: number, end: number, text: string, word: boolean}[]>} split
 */
export async function segmentAcross(units, split) {
  const ahead = (index) => {
    let text = ''
    for (let next = index + 1; next < units.length && text.length < SCAN_LENGTH; next++) text += units[next].text
    return text.slice(0, SCAN_LENGTH)
  }
  const found = await Promise.all(
    units.map(async (unit, index) => {
      // Only the last line runs on: a block's earlier lines end where they end.
      const runOn = unit.text.includes('\n') ? '' : ahead(index)
      const tokens = await split(unit.text + runOn)
      return tokens.filter((token) => token.start < unit.text.length)
    })
  )
  // How far into a unit the previous unit's last word already reaches.
  let covered = 0
  return units.map((unit, index) => {
    const tokens = found[index].map((token) => (token.start < covered ? { ...token, word: false } : token))
    const lastWord = [...tokens].reverse().find((token) => token.word)
    covered = Math.max(0, covered - unit.text.length)
    if (lastWord && lastWord.end > unit.text.length) covered = lastWord.end - unit.text.length
    return { ...unit, tokens }
  })
}

/**
 * The same units with one token per character, for stepping by character: every letter or digit
 * is a stop, punctuation and spaces are not. A lookup from a character reads on from there, so
 * this is how the reader starts a lookup where the word split went wrong.
 */
export function characterUnits(units) {
  return units.map((unit) => {
    const tokens = []
    let at = 0
    for (const character of unit.text) {
      tokens.push({ start: at, end: at + character.length, text: character, word: isWordText(character) })
      at += character.length
    }
    return { ...unit, tokens }
  })
}

/**
 * A cursor over the words of several boxes.
 *
 * @param {{text: string, vertical: boolean, tokens: {start: number, end: number, text: string, word: boolean}[]}[]} units
 *   the scan's boxes in reading order, each with its tokens
 */
export class WordCursor {
  constructor(units) {
    this.units = units
    /** The direction of the whole scan; see `dominantVertical`. */
    this.verticalText = dominantVertical(units)
    /** Every stoppable word, in reading order. */
    this.words = []
    /** Every line, in reading order, with the indices of its words. */
    this.lines = []
    units.forEach((unit, unitIndex) => {
      let lineStart = 0
      const lines = unit.text.split('\n')
      lines.forEach((line, lineIndex) => {
        const lineEnd = lineStart + line.length
        const entry = { unit: unitIndex, start: lineStart, end: lineEnd, words: [] }
        // A word on a box's last line may run on into the next box (OCR split it: 作|った), and
        // then `end` is past this box's text; see `segmentAcross`.
        const last = lineIndex === lines.length - 1
        for (const token of unit.tokens) {
          if (!token.word || token.start < lineStart || token.start >= lineEnd) continue
          entry.words.push(this.words.length)
          this.words.push({
            unit: unitIndex,
            start: token.start,
            end: last ? token.end : Math.min(token.end, lineEnd),
            text: token.text,
            line: this.lines.length,
            column: token.start - lineStart
          })
        }
        this.lines.push(entry)
        lineStart = lineEnd + 1
      })
    })
    this.index = this.words.length ? 0 : -1
  }

  get current() {
    return this.index >= 0 ? this.words[this.index] : null
  }

  get vertical() {
    return this.verticalText
  }

  /**
   * Go to the stop at `offset` in unit `unit`: the one covering it, else the last one before it
   * (in reading order), else the first after it. Returns whether there was one.
   */
  seek(unit, offset) {
    let best = -1
    for (let index = 0; index < this.words.length; index++) {
      const word = this.words[index]
      if (word.unit === unit && word.start <= offset && offset < word.end) {
        best = index
        break
      }
      if (word.unit < unit || (word.unit === unit && word.start <= offset)) best = index
      else {
        if (best < 0) best = index
        break
      }
    }
    if (best < 0) return false
    this.index = best
    return true
  }

  /** Move by `delta` words, stopping at either end. Returns whether the cursor moved. */
  step(delta) {
    if (this.index < 0) return false
    const next = Math.max(0, Math.min(this.words.length - 1, this.index + delta))
    if (next === this.index) return false
    this.index = next
    return true
  }

  /**
   * Make the current word `length` characters long: what the dictionary actually matched there,
   * when that differs from the split (剣でも matched as 剣; 思い matched as 思い返せば). Words it now
   * covers stop being stops; what it gives up becomes one, so stepping on lands there. A word may
   * run on into the following units, as a split one does.
   */
  fit(length) {
    const word = this.current
    if (!word || length <= 0 || word.start + length === word.end) return false
    const unitText = this.units[word.unit].text
    const end = word.start + length
    const removed = new Set()
    if (end > word.end) {
      // Grown: drop the stops it now covers, in its unit and the ones it runs on into.
      this.words.forEach((other, index) => {
        if (other === word) return
        let offset = 0
        for (let unit = word.unit; unit < other.unit; unit++) offset += this.units[unit].text.length
        const at = other.start + offset
        if (index > this.index && at < end) removed.add(index)
      })
    }
    const remainder =
      end < word.end && word.end <= unitText.length ? unitText.slice(end, word.end) : ''
    word.end = end
    word.text = unitText.slice(word.start, Math.min(end, unitText.length))
    const words = this.words.filter((_, index) => !removed.has(index))
    let index = words.indexOf(word)
    if (isWordText(remainder)) {
      // Shrunk: the rest of the split is a stop of its own, next.
      words.splice(index + 1, 0, {
        unit: word.unit,
        start: end,
        end: end + remainder.length,
        text: remainder,
        line: word.line,
        column: word.column + length
      })
    }
    this.words = words
    this.index = index
    for (const line of this.lines) line.words = []
    words.forEach((other, i) => this.lines[other.line].words.push(i))
    return true
  }

  /**
   * Move to the next (`delta` 1) or previous (-1) line that has a word on it, landing on the
   * word nearest the current one's place along the line.
   */
  line(delta) {
    const word = this.current
    if (!word) return false
    for (let line = word.line + delta; line >= 0 && line < this.lines.length; line += delta) {
      const candidates = this.lines[line].words
      if (!candidates.length) continue
      let best = candidates[0]
      for (const candidate of candidates) {
        const distance = Math.abs(this.words[candidate].column - word.column)
        if (distance < Math.abs(this.words[best].column - word.column)) best = candidate
      }
      this.index = best
      return true
    }
    return false
  }

  /**
   * A direction, read the way the current text runs: across a horizontal line it is the next
   * word to the right and the next line down; down a vertical column it is the next word below
   * and the next column to the left, since vertical Japanese reads right to left.
   */
  move(dir) {
    if (this.vertical) {
      if (dir === 'down') return this.step(1)
      if (dir === 'up') return this.step(-1)
      if (dir === 'left') return this.line(1)
      if (dir === 'right') return this.line(-1)
    } else {
      if (dir === 'right') return this.step(1)
      if (dir === 'left') return this.step(-1)
      if (dir === 'down') return this.line(1)
      if (dir === 'up') return this.line(-1)
    }
    return false
  }
}

export default {
  WordCursor,
  characterUnits,
  segmentText,
  tokensFromParse,
  tokensFromSegmenter,
  isWordText,
  readingUnits,
  dominantVertical,
  segmentAcross
}
