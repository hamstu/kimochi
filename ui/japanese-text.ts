/**
 * The Japanese filter, for the Log and the overlay alike: one setting (the Log's `japaneseFilter`,
 * in `superTexthooker`), one rule, applied to each line as it arrives in the Log and to each line
 * or passage the overlay draws.
 */

const CJK = /[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ一-鿿㐀-䶿々〆]/

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
 * Whether more than half of the text is not Japanese: OCR junk or an English label with a kana or
 * two in it. Spaces and punctuation are left out of the count; letters, digits and symbols that
 * are not Japanese count against it. Text with nothing to count is not judged.
 */
export function mostlyNonJapanese(text: string): boolean {
  let japanese = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) japanese++
    else if (!NEUTRAL.test(ch)) other++
  }
  return other > japanese
}

/**
 * - `off`: keep everything.
 * - `noJapanese` (the default): drop text with no Japanese at all.
 * - `mostlyNonJapanese`: also drop text that is more than half not Japanese.
 */
export type JapaneseFilterMode = 'off' | 'noJapanese' | 'mostlyNonJapanese'

export const JAPANESE_FILTER_MODES: readonly JapaneseFilterMode[] = ['off', 'noJapanese', 'mostlyNonJapanese']
export const DEFAULT_JAPANESE_FILTER: JapaneseFilterMode = 'noJapanese'

export interface JapaneseFilter {
  /** Absent means no filtering: only callers that read the Log's setting filter at all. */
  japaneseFilter?: JapaneseFilterMode
}

/** The filter from the Log's settings (`superTexthooker`), however much of them is there. */
export function japaneseFilterOf(reader: { japaneseFilter?: unknown } | null | undefined): Required<JapaneseFilter> {
  const mode = reader?.japaneseFilter
  return {
    japaneseFilter: JAPANESE_FILTER_MODES.includes(mode as JapaneseFilterMode)
      ? (mode as JapaneseFilterMode)
      : DEFAULT_JAPANESE_FILTER
  }
}

/** Whether the Japanese filter drops this text. */
export function dropsText(text: string, filter: JapaneseFilter): boolean {
  const mode = filter.japaneseFilter ?? 'off'
  if (mode === 'off') return false
  if (!hasCJK(text)) return true
  return mode === 'mostlyNonJapanese' && mostlyNonJapanese(text)
}
