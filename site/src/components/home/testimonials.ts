export interface Testimonial {
  /** The quote, without surrounding quotation marks. */
  quote: string
  /** Display name or handle. */
  name: string
  /** Optional context, e.g. "Reading Steins;Gate on a Steam Deck" or "JLPT N3". */
  detail?: string
  /** Optional link to where the quote was posted (with permission). */
  href?: string
}

/**
 * Quotes for the home page's testimonials section. The section renders nothing while this list
 * is empty, so it ships empty until real, permitted quotes exist.
 *
 * To enable: add entries (three reads best on desktop), e.g.
 *
 *   {
 *     quote: 'PLACEHOLDER: I finished my first visual novel in Japanese with this open beside it.',
 *     name: 'PLACEHOLDER Name',
 *     detail: 'PLACEHOLDER context'
 *   },
 *
 * Never ship placeholder or invented quotes.
 */
export const testimonials: Testimonial[] = []
