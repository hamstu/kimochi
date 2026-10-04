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
  return [...segmenter.segment(text)].map(({ segment, index, isWordLike }) => ({
    start: index,
    end: index + segment.length,
    text: segment,
    word: Boolean(isWordLike) && isWordText(segment)
  }))
}

/**
 * Split `text` into tokens, asking `parse` (Yomitan's `parseText`) first.
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
      const scanning = (results ?? []).find((result) => result?.source === 'scanning-parser')
      const tokens = tokensFromParse(text, scanning?.content)
      if (tokens.some((token) => token.word) || !JAPANESE.test(text)) return tokens
    } catch {
      // Fall through to the segmenter: a backend that is not ready yet must not leave the
      // reader with nothing to step through.
    }
  }
  return tokensFromSegmenter(text)
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
    /** Every stoppable word, in reading order. */
    this.words = []
    /** Every line, in reading order, with the indices of its words. */
    this.lines = []
    units.forEach((unit, unitIndex) => {
      let lineStart = 0
      unit.text.split('\n').forEach((line) => {
        const lineEnd = lineStart + line.length
        const entry = { unit: unitIndex, start: lineStart, end: lineEnd, words: [] }
        for (const token of unit.tokens) {
          if (!token.word || token.start < lineStart || token.start >= lineEnd) continue
          entry.words.push(this.words.length)
          this.words.push({
            unit: unitIndex,
            start: token.start,
            end: Math.min(token.end, lineEnd),
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
    const word = this.current
    return word ? Boolean(this.units[word.unit]?.vertical) : false
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

export default { WordCursor, segmentText, tokensFromParse, tokensFromSegmenter, isWordText }
