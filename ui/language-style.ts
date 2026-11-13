/**
 * How the learner's text is set, by the language being read (the `language` setting): the `lang`
 * attribute it carries, the typeface it is drawn in, and how the overlay's layout treats its
 * characters (text-layout.js, through the measure render.js builds; see `measureFor`).
 *
 * With Japanese every answer is what the app did before the setting existed: the same font stacks,
 * no `--kimochi-text-font` override, code-point characters, one em per character. Text that is
 * Japanese whatever the language (the app's own Japanese UI glyphs and samples) does not come here.
 *
 * Fonts are the platforms' own (nothing is bundled for other languages; bare Linux has only the
 * bundled Noto Sans JP, so a script without a system font there falls back to whatever is
 * installed). Each stack names the script's usual system fonts on macOS, Windows and Linux, then
 * the system UI stack for the Latin, digits and punctuation mixed into it.
 */
import { languageOf, type Language, type ScriptCode } from './languages.js'

/**
 * Japanese text in the overlay (render.js `GROUP_FONT`, overlay-text.css, hook-card.css): the
 * platform's Japanese gothic, whose kana and kanji all advance one em.
 */
export const JAPANESE_TEXT_FONT =
  "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Noto Sans CJK JP', 'Yu Gothic', 'Meiryo', sans-serif"

/**
 * The system UI faces, for Latin, Cyrillic and Greek: proportional, kerned, with each script's own
 * letter shapes. (A Japanese font draws Cyrillic and Greek full-width; the app's Figtree has no
 * Cyrillic or Greek, and loads on demand, which a canvas measuring the overlay cannot wait for.)
 */
const SYSTEM_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Roboto, Ubuntu, Cantarell, 'DejaVu Sans', 'Helvetica Neue', Arial, sans-serif"

/** Fonts for each script, best first, before the system UI stack. */
const SCRIPT_FONTS: Readonly<Record<ScriptCode, string>> = {
  Jpan: JAPANESE_TEXT_FONT,
  // Han in the forms each region reads, then Hangul, from the platforms' own CJK families.
  Hans: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei'",
  Hant: "'PingFang TC', 'Microsoft JhengHei UI', 'Microsoft JhengHei', 'Noto Sans CJK TC', 'Noto Sans TC', 'Source Han Sans TC'",
  Kore: "'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR', 'Noto Sans KR', 'Source Han Sans K', 'NanumGothic'",
  Latn: '',
  Cyrl: '',
  Grek: '',
  Deva: "'Kohinoor Devanagari', 'Devanagari Sangam MN', 'Nirmala UI', 'Noto Sans Devanagari'",
  Thai: "'Thonburi', 'Leelawadee UI', 'Noto Sans Thai', 'Noto Sans Thai UI'",
  Khmr: "'Khmer Sangam MN', 'Leelawadee UI', 'Khmer UI', 'Noto Sans Khmer'",
  Laoo: "'Lao Sangam MN', 'Leelawadee UI', 'Lao UI', 'Noto Sans Lao'",
  Knda: "'Kannada Sangam MN', 'Nirmala UI', 'Noto Sans Kannada'",
  Geor: "'Noto Sans Georgian', 'Sylfaen'",
  Armn: "'Mshtakan', 'Noto Sans Armenian', 'Sylfaen'"
}

/** Cantonese reads Traditional Han in Hong Kong's forms. */
const HONG_KONG = "'PingFang HK', 'Noto Sans CJK HK', 'Noto Sans HK', 'Microsoft JhengHei UI', 'Microsoft JhengHei'"

/** Scripts set on a grid of em squares: one em per character, split by code point. */
const FULL_WIDTH: ReadonlySet<ScriptCode> = new Set(['Jpan', 'Hans', 'Hant', 'Kore'])

/**
 * Scripts whose letters shape and stack together (conjuncts, vowel signs above and below): spacing
 * them glyph by glyph, or wrapping glyphs in spans of their own, breaks the shaping.
 */
const SHAPED: ReadonlySet<ScriptCode> = new Set(['Deva', 'Thai', 'Khmr', 'Laoo', 'Knda'])

export interface TextStyle {
  /** The language's code (languages.ts). */
  code: string
  /** Japanese, which is set exactly as before the setting existed. */
  japanese: boolean
  /** The `lang` attribute for the learner's text: the BCP 47 code. */
  lang: string
  /** The font stack the learner's text is set in. */
  font: string
  /** Set on a grid of em squares (Japanese, Chinese, Korean): one em per code point. */
  fullWidth: boolean
  /** Words are separated by spaces. */
  spaces: boolean
  /** Letters shape together, so are never spaced or split one by one. */
  shaped: boolean
}

const styles = new Map<string, TextStyle>()

/** How the learner's text is set in the language `code` (absent or unknown: Japanese). */
export function textStyle(code?: unknown): TextStyle {
  const language: Language = languageOf(code)
  const known = styles.get(language.code)
  if (known) return known
  const japanese = language.code === 'ja'
  const own =
    language.code === 'yue'
      ? HONG_KONG
      : [...new Set(language.scripts.map((script) => SCRIPT_FONTS[script]).filter(Boolean))].join(', ')
  const style: TextStyle = {
    code: language.code,
    japanese,
    lang: language.code,
    font: japanese ? JAPANESE_TEXT_FONT : own ? `${own}, ${SYSTEM_FONT}` : SYSTEM_FONT,
    fullWidth: language.scripts.some((script) => FULL_WIDTH.has(script)),
    spaces: language.spaces,
    shaped: language.scripts.some((script) => SHAPED.has(script))
  }
  styles.set(language.code, style)
  return style
}

/** The `lang` attribute for the learner's text in the language `code`. */
export const textLang = (code?: unknown): string => textStyle(code).lang

/** The font stack for the learner's text in the language `code`. */
export const textFont = (code?: unknown): string => textStyle(code).font

/**
 * The custom property every surface that draws the learner's text reads its font from, with its
 * own Japanese stack as the fallback (overlay-text.css, hook-card.css, `--k-font-text` in
 * tokens.css). Set only for a language other than Japanese, so Japanese is drawn exactly as it
 * always was.
 */
export const TEXT_FONT_PROPERTY = '--kimochi-text-font'

/**
 * Points `root`'s learner-text font at the language `code` (see TEXT_FONT_PROPERTY), and marks it
 * with the language (`data-text-lang`) for styles that differ by script.
 */
export function applyTextStyle(
  code: unknown,
  root: HTMLElement | null = globalThis.document?.documentElement ?? null
): void {
  if (!root) return
  const style = textStyle(code)
  if (style.japanese) {
    root.style.removeProperty(TEXT_FONT_PROPERTY)
    delete root.dataset.textLang
  } else {
    root.style.setProperty(TEXT_FONT_PROPERTY, style.font)
    root.dataset.textLang = style.lang
  }
}

type Segmenter = { segment: (text: string) => Iterable<{ segment: string }> }
const SegmenterClass = (Intl as unknown as { Segmenter?: new (locale?: string, options?: object) => Segmenter })
  .Segmenter
const graphemeSegmenter: Segmenter | null = SegmenterClass
  ? new SegmenterClass(undefined, { granularity: 'grapheme' })
  : null

/** A grapheme cluster where there is no segmenter: a character and the marks that follow it. */
const CLUSTER = /\P{M}[\p{M}\u200c\u200d]*|[\p{M}\u200c\u200d]+/gsu

/** `text`'s grapheme clusters: a letter with its combining marks is one. */
export function graphemes(text: string): string[] {
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
  return text.match(CLUSTER) ?? []
}

/**
 * The characters of `text` as the overlay places them, in the language `code`: code points for
 * Japanese, Chinese and Korean (exactly as before), grapheme clusters for every other script, so a
 * combining accent, a Thai vowel sign or a Devanagari matra never comes apart from its letter.
 */
export function textUnits(text: string, code?: unknown): string[] {
  return textStyle(code).fullWidth ? [...text] : graphemes(text)
}

const wordSegmenters = new Map<string, Segmenter | null>()

/**
 * `text` cut where a line of it may break, each piece with the spaces after it: at spaces in a
 * language that spaces its words, at word boundaries (`Intl.Segmenter`) in one that does not
 * (Thai, Lao, Khmer). Joined, the pieces are `text`.
 */
export function wordPieces(text: string, code?: unknown): string[] {
  const style = textStyle(code)
  if (style.spaces) return text.match(/\s+|\S+\s*/gu) ?? []
  let segmenter = wordSegmenters.get(style.code)
  if (segmenter === undefined) {
    segmenter = SegmenterClass ? new SegmenterClass(style.code, { granularity: 'word' }) : null
    wordSegmenters.set(style.code, segmenter)
  }
  if (!segmenter) return graphemes(text)
  const pieces: string[] = []
  for (const { segment } of segmenter.segment(text)) {
    // Spaces and punctuation stay with the word before them, as a line ends after them.
    if (pieces.length && !/[\p{L}\p{N}]/u.test(segment)) pieces[pieces.length - 1] += segment
    else pieces.push(segment)
  }
  return pieces
}

/**
 * A character's advance in ems where nothing can measure it (no canvas: tests, and the first
 * frame), for a language other than Japanese: proportional letters about half an em, narrow ones
 * and spaces less, CJK and full-width forms a whole em, combining marks nothing.
 */
export function estimateAdvance(text: string): number {
  let ems = 0
  for (const c of text) ems += advanceOf(c)
  return ems
}

function advanceOf(c: string): number {
  if (/\p{M}|[\u200b-\u200d\u2060\ufeff]/u.test(c)) return 0
  if (/\s/u.test(c)) return c === '\u3000' ? 1 : 0.28
  if (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u.test(
      c
    )
  )
    return /[\uff61-\uff9f]/u.test(c) ? 0.5 : 1
  if (/[ijlI|!.,:;'\u2019`]/u.test(c)) return 0.27
  if (/[mwMW]/u.test(c)) return 0.82
  if (/\p{Lu}/u.test(c)) return 0.66
  if (/\p{N}/u.test(c)) return 0.56
  if (/\p{L}/u.test(c)) return /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(c) ? 0.53 : 0.62
  return 0.36
}
