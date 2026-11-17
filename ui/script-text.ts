/**
 * Which characters belong to a writing system (`ScriptCode` in languages.ts), for the gates that
 * keep only text in the language being read: the line filter (japanese-text.ts), the words the
 * controller steps through (word-nav.js) and what Auto OCR writes to the history (scene.ts).
 *
 * `Jpan` is the pattern the Japanese filter has always used, character for character, so with
 * Japanese every gate keeps exactly what it kept before.
 */
import { languageOf, type ScriptCode } from './languages.js'

export const SCRIPT_PATTERNS: Readonly<Record<ScriptCode, RegExp>> = {
  // Hiragana, Katakana (full and half width), CJK Unified Ideographs and Ext A, 々 and 〆.
  Jpan: /[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ一-鿿㐀-䶿々〆]/,
  // Hangul alone, as native has it (language.rs): with Han, Japanese and Chinese lines would read
  // as Korean.
  Kore: /\p{Script=Hangul}/u,
  Hans: /[\p{Script=Han}々〆]/u,
  Hant: /[\p{Script=Han}々〆]/u,
  Latn: /\p{Script=Latin}/u,
  Cyrl: /\p{Script=Cyrillic}/u,
  Grek: /\p{Script=Greek}/u,
  Deva: /\p{Script=Devanagari}/u,
  Thai: /\p{Script=Thai}/u,
  Geor: /\p{Script=Georgian}/u,
  Armn: /\p{Script=Armenian}/u,
  Khmr: /\p{Script=Khmer}/u,
  Laoo: /\p{Script=Lao}/u,
  Knda: /\p{Script=Kannada}/u
}

/** Whether any character of `text` is written in one of `scripts`. */
export function hasScript(text: string, scripts: readonly ScriptCode[]): boolean {
  return scripts.some((script) => SCRIPT_PATTERNS[script].test(text))
}

/** Whether `text` has any character in the scripts of the language `code` (absent: Japanese). */
export function hasLanguageScript(text: string, code?: string): boolean {
  return hasScript(text, languageOf(code).scripts)
}

/**
 * What goes between two pieces of text OCR read apart (two words, two boxes, two lines run
 * together): a space in a language that separates its words with one, unless one side already
 * has it; nothing in a language that does not (Japanese, Chinese, Thai).
 */
export function joiner(before: string, after: string, language?: string): string {
  if (!before || !after || !languageOf(language).spaces) return ''
  return /\s$/u.test(before) || /^\s/u.test(after) ? '' : ' '
}

/** How a word broken across two lines goes back together (`wordBreak`). */
export type WordBreak = 'drop' | 'keep'

/** The language is written in the Latin alphabet. */
const latin = (language?: string): boolean => languageOf(language).scripts.includes('Latn')

/** A line that ends in a hyphen straight after a letter (`esta-`, not `esta -` or `3-`). */
const BROKEN = /\p{L}\p{M}*[-\u2010\u00ad]\s*$/u

/** `wordBreak` once the language is known to be written in the Latin alphabet. */
function hyphenBreak(before: string, after: string): WordBreak | null {
  if (!BROKEN.test(before) || !/^\s*\p{L}/u.test(after)) return null
  return /^\s*\p{Lu}/u.test(after) ? 'keep' : 'drop'
}

/**
 * A word broken across two lines with a hyphen, in a language written in the Latin alphabet:
 * `before`, a line that is not the last, ends in a hyphen straight after a letter, and `after`, the
 * next line, starts with a letter. The two are one word, never two with a space between. The
 * hyphen was only where the line broke (`drop`: `esta-` `ba` is `estaba`), unless the next line
 * starts with a capital, where the word has a hyphen of its own (`keep`: `Baden-` `Württemberg`).
 * Null when the lines are not one word, and always in other alphabets. src-tauri/src/text_hook/
 * clean.rs `word_break` is the same rule for the Text Hooker.
 */
export function wordBreak(before: string, after: string, language?: string): WordBreak | null {
  return latin(language) ? hyphenBreak(before, after) : null
}

/** `before` as it runs into the next line of a word broken across them (`wordBreak`). */
export function brokenWordStart(before: string, split: WordBreak): string {
  const kept = before.trimEnd()
  return split === 'drop' ? kept.slice(0, -1) : kept
}

/**
 * Text with its line breaks (`\n`) as OCR or the game had them, with each word a line broke with
 * a hyphen put back together (`wordBreak`): `esta-\nba` is `estaba`. Other breaks stay.
 */
export function joinBrokenWords(text: string, language?: string): string {
  if (!text.includes('\n') || !latin(language)) return text
  const lines = text.split('\n')
  let joined = lines[0]
  for (let i = 1; i < lines.length; i++) {
    // The text so far ends as the line before it does: that line is the one to test.
    const split = hyphenBreak(lines[i - 1], lines[i])
    joined = split ? brokenWordStart(joined, split) + lines[i].trimStart() : `${joined}\n${lines[i]}`
  }
  return joined
}
