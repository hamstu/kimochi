/**
 * The line filter, for the Log and the overlay alike: one setting (the Log's `japaneseFilter`,
 * in `superTexthooker`), one rule, applied to each line as it arrives in the Log and to each line
 * or passage the overlay draws.
 *
 * Named for Japanese, the language it was written for, and still stored under that name with its
 * old values, so a Japanese reader's choice carries over. It keeps text in the scripts of the
 * language being read (the `language` setting, script-text.ts): kana and kanji for Japanese,
 * Hangul and Han for Korean, Cyrillic for Russian. Without a language it is Japanese.
 */
import { isJapanese, languageOf } from './languages.js'
import { SCRIPT_PATTERNS, hasScript } from './script-text.js'

const CJK = SCRIPT_PATTERNS.Jpan

/**
 * True if the text contains any Japanese / CJK characters: Hiragana, Katakana (full and
 * half-width), CJK Unified Ideographs and Ext A, and 々, 〆.
 */
export function hasCJK(text: string): boolean {
  return CJK.test(text)
}

/** Spaces and punctuation (、。「」…!?) say nothing about the language either way. */
const NEUTRAL = /[\s\p{P}]/u
/**
 * Nor, in other languages, do combining marks (an accent typed as its own character): they
 * belong to the letter before them. Japanese counts them as it always has.
 */
const NEUTRAL_OR_MARK = /[\s\p{P}\p{M}]/u

/**
 * Whether more than half of the text is not in the language (Japanese unless `language` says
 * otherwise): OCR junk, or an English label with a kana or two in it. Spaces and punctuation are
 * left out of the count; letters, digits and symbols in other scripts count against it. Text with
 * nothing to count is not judged.
 */
export function mostlyNonJapanese(text: string, language?: string): boolean {
  const scripts = languageOf(language).scripts
  const neutral = isJapanese(language) ? NEUTRAL : NEUTRAL_OR_MARK
  let own = 0
  let other = 0
  for (const ch of text) {
    if (hasScript(ch, scripts)) own++
    else if (!neutral.test(ch)) other++
  }
  return other > own
}

/**
 * - `off`: keep everything.
 * - `noJapanese` (the default): drop text with nothing in the language's scripts.
 * - `mostlyNonJapanese`: also drop text that is more than half in other scripts.
 */
export type JapaneseFilterMode = 'off' | 'noJapanese' | 'mostlyNonJapanese'

export const JAPANESE_FILTER_MODES: readonly JapaneseFilterMode[] = ['off', 'noJapanese', 'mostlyNonJapanese']
export const DEFAULT_JAPANESE_FILTER: JapaneseFilterMode = 'noJapanese'

export interface JapaneseFilter {
  /** Absent means no filtering: only callers that read the Log's setting filter at all. */
  japaneseFilter?: JapaneseFilterMode
  /** The language being read (a code from languages.ts); absent means Japanese. */
  language?: string
}

/**
 * The filter from the Log's settings (`superTexthooker`), however much of them is there, for the
 * language being read (the top-level `language` setting) when the caller knows it.
 */
export function japaneseFilterOf(
  reader: { japaneseFilter?: unknown } | null | undefined,
  language?: string
): Required<Pick<JapaneseFilter, 'japaneseFilter'>> & JapaneseFilter {
  const mode = reader?.japaneseFilter
  return {
    japaneseFilter: JAPANESE_FILTER_MODES.includes(mode as JapaneseFilterMode)
      ? (mode as JapaneseFilterMode)
      : DEFAULT_JAPANESE_FILTER,
    ...(typeof language === 'string' ? { language } : {})
  }
}

/** Whether the filter drops this text. */
export function dropsText(text: string, filter: JapaneseFilter): boolean {
  const mode = filter.japaneseFilter ?? 'off'
  if (mode === 'off') return false
  if (!hasScript(text, languageOf(filter.language).scripts)) return true
  return mode === 'mostlyNonJapanese' && mostlyNonJapanese(text, filter.language)
}
