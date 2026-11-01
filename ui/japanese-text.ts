/**
 * "Japanese only", for the Log and the overlay alike: one setting (the Log's `cjkOnly` and
 * `cjkOnlyLatinEdges`, in `superTexthooker`), one rule, applied to each line as it arrives in
 * the Log and to each line or passage the overlay draws.
 */

/**
 * True if the text contains any Japanese / CJK characters: Hiragana, Katakana (full and
 * half-width), CJK Unified Ideographs and Ext A, and 々, 〆.
 */
export function hasCJK(text: string): boolean {
  return /[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ一-鿿㐀-䶿々〆]/.test(text)
}

const LETTER = /\p{L}/u
const LATIN = /\p{Script=Latin}/u

/**
 * Whether a line's first or last letter is a Roman one: the stricter mode, for an English menu
 * item or label that happens to carry a kana or a kanji ("Save データ", "Lv.5 勇者"), which the
 * plain filter lets through because it drops only lines with no Japanese at all.
 *
 * Letters only: punctuation, brackets, digits, spaces and symbols at either end are looked past,
 * so 「はい」 or …123 are judged by the letters inside them. Full-width Roman letters (Ｈ, ｐ) count
 * as Roman. It can drop real lines that begin or end with a Roman word ("HPが減った"), which is
 * why it is off unless asked for.
 */
export function latinAtEdge(text: string): boolean {
  const letters = Array.from(text).filter((ch) => LETTER.test(ch))
  if (letters.length === 0) return false
  return LATIN.test(letters[0]) || LATIN.test(letters[letters.length - 1])
}

export interface JapaneseFilter {
  /** `cjkOnly`: drop text with no Japanese at all. */
  japaneseOnly?: boolean
  /** `cjkOnlyLatinEdges`: with `japaneseOnly`, also drop text whose first or last letter is Roman. */
  latinEdges?: boolean
}

/** The filter from the Log's settings (`superTexthooker`), however much of them is there. */
export function japaneseFilterOf(
  reader: { cjkOnly?: unknown; cjkOnlyLatinEdges?: unknown } | null | undefined
): JapaneseFilter {
  return { japaneseOnly: reader?.cjkOnly === true, latinEdges: reader?.cjkOnlyLatinEdges === true }
}

/** Whether "Japanese only" drops this text. */
export function dropsText(text: string, filter: JapaneseFilter): boolean {
  if (!filter.japaneseOnly) return false
  if (!hasCJK(text)) return true
  return Boolean(filter.latinEdges) && latinAtEdge(text)
}
