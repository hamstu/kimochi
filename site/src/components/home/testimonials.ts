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
 * Quotes for the home page's testimonials section (three reads best on desktop). The section
 * renders nothing while this list is empty; add real, permitted quotes here.
 */
export const testimonials: Testimonial[] = []
