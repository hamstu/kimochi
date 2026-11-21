/**
 * Following new lines in the Log: when the reader is at or near the end, new lines (and lines
 * that grow after they are laid out: furigana, a wrap, a screenshot, a note) keep the end in view.
 * A reader who has scrolled up to older lines is left where they are until they come back down.
 */

/** Where a scrolling box is: its `scrollTop`, `scrollHeight` and `clientHeight`. */
export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Pixels the view's end is above the content's end (0 at the very bottom). */
export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight)
}

/**
 * How far from the end still counts as "at the end": about two lines of the Log's text (a line
 * with furigana is about twice the font size tall), and never less than 80 px.
 */
export function followThreshold(fontSizePx: number): number {
  return Math.max(80, Math.round(fontSizePx * 4))
}

/**
 * Whether the Log keeps following after the box scrolled to `m` from `previousTop`.
 *
 * Near the end it follows. Further away it stops only when the view moved up: the content growing
 * under a following view (a line taller once laid out, an image loading) leaves `scrollTop` where
 * it was, and that must not count as the reader scrolling away. A reader scrolled up who moves
 * down, but not yet near the end, stays unfollowed.
 */
export function followAfterScroll(
  m: ScrollMetrics,
  previousTop: number,
  following: boolean,
  threshold: number
): boolean {
  if (distanceFromBottom(m) <= threshold) return true
  // A pixel of slack: fractional scroll positions round differently between reads.
  if (m.scrollTop < previousTop - 1) return false
  return following
}
