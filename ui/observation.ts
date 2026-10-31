/**
 * Comparing what the local observer saw, one observation against the next.
 *
 * This is the semantic half of automatic OCR: everything here is a pure function
 * over text and boxes, with no clock, no capture, no platform and no network, so
 * the policy that decides when an expensive recognition is justified can be
 * tested exhaustively and behaves identically on macOS and Windows.
 *
 * Two normalisations, deliberately, because two different questions are being
 * asked and answering both with one string is how a fuzzy comparator ends up
 * swallowing a real change:
 *
 *  - `stabilityKey` decides *has this stopped moving*. It drops whitespace and
 *    punctuation, because a local recogniser flickering between 「ね」 and 「ね、」
 *    on a frozen screen is noise, and noise that prevented settling would mean
 *    the line never gets recognised at all.
 *  - `identityKey` decides *is this the same line we already sent or already
 *    showed*. It keeps punctuation and only folds compatibility forms and
 *    whitespace runs, because 「行く」 and 「行く？」 are not the same sentence.
 *
 * Neither is fuzzy. Settling and deduplication both require exact equality of a
 * key; similarity is used only to recognise that two observations are the *same
 * line still being drawn* — which resets the settle count rather than declaring
 * anything equal.
 *
 * The guarantee that buys: **a one-character difference is never absorbed, at any
 * line length.** That is worth stating as a length-independent property, because
 * the natural alternative is not. A ratio-based comparator absorbs a
 * one-character change once the line is long enough — one character in twenty is
 * 95% similar — so the same edit that reads as new text in a short line
 * disappears in a long one. 「殺す」 and 「返す」 differ by one character and by
 * everything else, whatever surrounds them.
 */

/** A rectangle in the observed frame's own pixels, top-left origin. */
export interface TextBox {
  x: number
  y: number
  width: number
  height: number
}

/** One recognised line: its text and where the observer found it. */
export interface ObservedLine {
  text: string
  box: TextBox
  /**
   * How strongly each part of the line stands out from its background, from native: a
   * few cells along the line, each the spread of its pixels' brightness. Text that is
   * still fading or drawing in changes this while its words read the same.
   */
  ink?: number[]
}

/** One local first-pass result. `text` is the lines joined in reading order. */
export interface Observation {
  text: string
  lines: ObservedLine[]
  /** How long the watcher took to read the frame, when it says. */
  durationMs?: number
}

/**
 * Compatibility folding plus whitespace removal.
 *
 * NFKC is what makes full-width ＡＢＣ and half-width ｱｲｳ compare equal to the
 * forms the accurate recogniser returns; Japanese text has no meaningful spaces,
 * so a line break moving mid-sentence must not read as new dialogue.
 */
function fold(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '')
}

/**
 * Punctuation that a local recogniser flickers on, and nothing else.
 *
 * Listed one character at a time rather than taken from `\p{P}` and `\p{S}`,
 * because those classes also contain every character that carries meaning by
 * being a symbol: ＋ − × ÷ ＝ ≠ ≦ ≧ ％ ℃ ° ¥ ＄ € £ ₩ № and the rest. Dropping
 * those would make 「500円」 and 「500%」 settle as the same observation, which is
 * exactly the failure this file exists to avoid.
 *
 * What is here is sentence furniture: the ideographic comma and full stop, the
 * middle dot, brackets and quotes, the ellipsis, the wave dash and the long
 * dashes, plus their ASCII forms (full-width ！？（）：；，． have already folded
 * to ASCII under NFKC). The hyphen-minus is deliberately absent — it is also the
 * minus sign — and so are ＜ ＞, which are comparisons.
 */
const PUNCTUATION_NOISE =
  /[\u3001\u3002\u30FB\u2026\u2025\u300C\u300D\u300E\u300F\u3010\u3011\u3014\u3015\u3008\u3009\u300A\u300B\u301C\uFF5E\u2015\u2014\u2013\u2019\u2018\u201C\u201D,.:;!?'"`()[\]{}]/gu

/**
 * The key that settling counts on. Sentence punctuation is dropped so observer
 * jitter around 「。」「、」「…」 cannot hold a line open forever.
 *
 * The prolonged sound mark ー and the iteration mark 々 are modifier letters, not
 * punctuation, and survive — as do every currency, percentage and arithmetic
 * sign, because those distinguish sentences rather than decorate them.
 */
export function stabilityKey(text: string): string {
  return fold(text).replace(PUNCTUATION_NOISE, '')
}

/**
 * The key that deduplication compares. Punctuation is preserved: this is what
 * decides whether an expensive request is worth making and whether a result is
 * worth writing to the history, and both of those must be able to tell 「はい」
 * from 「はい？」.
 */
export function identityKey(text: string): string {
  return fold(text)
}

export function isEmptyText(text: string): boolean {
  return stabilityKey(text) === ''
}

/** How a new observation relates to the candidate already being watched. */
export type Relation =
  /** The same text again: this is what settling counts. */
  | 'identical'
  /** The candidate is a prefix of the new text: a line still being typed out. */
  | 'growth'
  /** The new text is a prefix of the candidate: a dropped tail, keep the longer. */
  | 'shrink'
  /** Enough shared opening to be the same line redrawn, but neither is a prefix. */
  | 'evolving'
  /** Different text in the same place, or somewhere else: a new line. */
  | 'replacement'
  /** Nothing readable any more. */
  | 'empty'
  /** There was no candidate to compare against. */
  | 'first'

export interface RelationOptions {
  /** Shortest shared opening that can still mean "the same line, redrawn". */
  minCommonPrefix: number
  /**
   * How many trailing characters of the shorter observation may disagree and
   * still count as the same line being drawn. One, by default: the glyph
   * currently appearing is the one a recogniser gets wrong on the way in.
   */
  tailJitter: number
}

export const DEFAULT_RELATION_OPTIONS: RelationOptions = { minCommonPrefix: 3, tailJitter: 1 }

export function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) i++
  return i
}

/**
 * Classify a new observation against the candidate. Both arguments are already
 * `stabilityKey`ed.
 *
 * The `evolving` fallback exists for one specific situation: a line being typed
 * out, whose final glyph is half-drawn and so is read as something else on the
 * way in, leaving neither observation a clean prefix of the other. It is
 * deliberately narrow — the new text must actually be longer, and everything but
 * the last character or so of the shorter one must match.
 *
 * Narrow, because the obvious wider rule ("mostly the same, so the same line") is
 * precisely the bug this module is written to avoid, and it bites hardest exactly
 * where it is least visible. A similarity threshold is a proportion, so how much
 * of a sentence has to change before it counts as changed grows with the
 * sentence: one character in six is 83% similar and survives a 90% threshold,
 * while one character in twenty is 95% similar and does not. Requiring equality
 * removes the length dependence — 「今日は寒いね」 and 「今日は寒いよ」 are the same
 * length, nothing was added, so this returns `replacement` and the reader gets
 * the second line, and the same holds for a sentence three times as long.
 */
export function classify(
  previous: string | null,
  next: string,
  options: RelationOptions = DEFAULT_RELATION_OPTIONS
): Relation {
  if (next === '') return 'empty'
  if (previous === null || previous === '') return 'first'
  if (previous === next) return 'identical'
  if (next.startsWith(previous)) return 'growth'
  if (previous.startsWith(next)) return 'shrink'
  const shared = commonPrefixLength(previous, next)
  const shorter = Math.min(previous.length, next.length)
  const longer = Math.max(previous.length, next.length)
  const grew = longer > shorter
  if (grew && shared >= options.minCommonPrefix && shorter - shared <= options.tailJitter) {
    return 'evolving'
  }
  return 'replacement'
}

/** Relations that mean "still the same line, just not finished". */
export function isEvolving(relation: Relation): boolean {
  return relation === 'growth' || relation === 'shrink' || relation === 'evolving'
}

export function boxesOverlap(a: TextBox, b: TextBox, tolerance: number): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  )
}

/**
 * Do two observations describe the same layout?
 *
 * This is reported and counted, never used to suppress a request. GSM's
 * detection-only path rejects a crop whose coordinates match the last one it
 * processed, which silently loses a replacement line drawn into exactly the same
 * dialogue box — the single most common thing a visual novel does. Layout here
 * only explains *why* a decision was made.
 */
export function sameLayout(
  a: ObservedLine[] | null,
  b: ObservedLine[] | null,
  tolerance: number
): boolean {
  if (!a || !b || a.length === 0 || a.length !== b.length) return false
  return a.every((line, index) => boxesOverlap(line.box, b[index].box, tolerance))
}

/** The smallest box containing every line, or null when there are none. */
export function unionBox(lines: ObservedLine[] | null | undefined): TextBox | null {
  if (!lines || lines.length === 0) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const { box } of lines) {
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * A coarse, stable description of where the text is, for counters and logs.
 *
 * Rounded hard so that a box breathing by a pixel between frames does not
 * produce a different label every tick. Carries no recognised text.
 */
export function layoutSignature(lines: ObservedLine[] | null | undefined, grid = 8): string {
  const union = unionBox(lines)
  if (!union) return 'none'
  const snap = (value: number): number => Math.round(value / grid) * grid
  return `${lines?.length ?? 0}@${snap(union.x)},${snap(union.y)},${snap(union.width)}x${snap(union.height)}`
}
