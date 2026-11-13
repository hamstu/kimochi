/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Linux runtime bridge. */
import { layoutGroup, characterCells } from './text-layout.js'

/** What a word is made of in a language that spaces its words: letters, marks, digits, an apostrophe. */
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}'’]/u

/**
 * Fit the existing reader's character geometry to an OCR screen rectangle: one cell per character,
 * each looking up from that character on, as Japanese is read. With `spaced` (a language that
 * spaces its words) a word's characters on one line are one cell, looking up from the word's
 * start, so the pointer anywhere in a word finds the word rather than its tail; spaces and
 * punctuation keep a cell each, as before.
 */
export function gnomeWordCells(text, rect, vertical = false, measure = (text) => [...text].length, spaced = false) {
  const runs = layoutGroup([{ text, rect, block: text.includes('\n') }], vertical, measure)
  const cells = characterCells(text, runs, vertical, measure)
  const seen = new Set()
  const out = cells.flatMap((cell, offset) => {
    if (!cell || seen.has(cell)) return []
    seen.add(cell)
    const x = Math.max(rect.x, cell.x),
      y = Math.max(rect.y, cell.y)
    const width = Math.min(rect.x + rect.width, cell.x + cell.width) - x
    const height = Math.min(rect.y + rect.height, cell.y + cell.height) - y
    return width > 0 && height > 0 ? [{ text: text.slice(offset), sentence: text, offset, x, y, width, height }] : []
  })
  return spaced ? wordsOf(out, text, vertical) : out
}

/** Neighbouring cells of one word on one line, as one cell from the word's start. */
function wordsOf(cells, text, vertical) {
  const words = []
  let last = null
  let end = -1
  for (const cell of cells) {
    const character = String.fromCodePoint(text.codePointAt(cell.offset))
    const word = WORD_CHARACTER.test(character)
    const sameLine =
      last &&
      (vertical
        ? Math.abs(cell.x + cell.width / 2 - (last.x + last.width / 2)) < Math.min(cell.width, last.width) / 2
        : Math.abs(cell.y + cell.height / 2 - (last.y + last.height / 2)) < Math.min(cell.height, last.height) / 2)
    if (word && last && cell.offset === end && sameLine) {
      const right = Math.max(last.x + last.width, cell.x + cell.width)
      const bottom = Math.max(last.y + last.height, cell.y + cell.height)
      last.x = Math.min(last.x, cell.x)
      last.y = Math.min(last.y, cell.y)
      last.width = right - last.x
      last.height = bottom - last.y
    } else {
      last = word ? { ...cell } : null
      words.push(last ?? cell)
    }
    end = cell.offset + character.length
  }
  return words
}

/** Controller metadata must not limit the shared WebView's text. Intern the
 * repeated sentences so long OCR lines cannot overflow the bounded Shell RPC. */
export function packGnomeWords(words, limit = 220000) {
  const sentences = [],
    indices = new Map(),
    packed = []
  let size = 64
  for (const word of words) {
    let id = indices.get(word.sentence)
    const fresh = id === undefined
    if (fresh) id = sentences.length
    const cell = { sentenceId: id, offset: word.offset, x: word.x, y: word.y, width: word.width, height: word.height }
    const added = JSON.stringify(cell).length + (fresh ? JSON.stringify(word.sentence).length : 0) + 2
    if (size + added > limit) break
    if (fresh) {
      indices.set(word.sentence, id)
      sentences.push(word.sentence)
    }
    packed.push(cell)
    size += added
  }
  return { words: packed, sentences }
}
