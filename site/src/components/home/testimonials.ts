// PLACEHOLDER quotes, replace before launch.
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
 * renders nothing when this list is empty.
 *
 * PLACEHOLDER: the three entries below are invented stand-ins for layout. Replace them with real,
 * permitted quotes (or empty the list) before launch.
 */
export const testimonials: Testimonial[] = [
  {
    quote:
      'I used to alt-tab to a dictionary every other line. Now I hover the word and keep reading. Finished my first full route in Japanese last month.',
    name: 'Mika',
    detail: 'Reads visual novels on a MacBook'
  },
  {
    quote: 'Both sticks, Scan, D-pad to the word. It works from the couch without ever touching a keyboard.',
    name: 'Daniel',
    detail: 'Plays on a Steam Deck in Gaming Mode'
  },
  {
    quote:
      'The sentence, the reading and the audio land in Anki in one click. My mining went from a chore to something I barely notice.',
    name: 'Aiko',
    detail: 'Anki miner, around JLPT N3'
  }
]
