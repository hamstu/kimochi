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
