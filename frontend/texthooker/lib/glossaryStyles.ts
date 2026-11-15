/**
 * A lookup's dictionary stylesheets, once each.
 *
 * Yomitan's `glossary` marker carries each dictionary's stylesheet (`styles.css`, sanitized) inside
 * the glossary, once per dictionary per entry, so an Anki card made from any one entry is styled on
 * its own. In a pop-up showing every entry of a lookup that repeats them: with many styled
 * dictionaries most of the answer is the same stylesheets over and over (見る with 27 dictionaries:
 * 225 KB of its 266 KB), each copy sanitized, parsed and matched again. The pop-up shows the
 * entries without them and the distinct stylesheets once; the rules are the same (every copy of a
 * dictionary's sheet is identical and applies document-wide), and the fields given to Add to Anki
 * keep theirs.
 */
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi

export interface SharedStyles {
  /** Each glossary without its `<style>` elements. */
  glossaries: string[]
  /** The distinct stylesheets' text, in first-seen order. */
  css: string
}

export function shareGlossaryStyles(glossaries: readonly string[]): SharedStyles {
  const seen = new Set<string>()
  const stripped = glossaries.map((html) =>
    html.replace(STYLE, (_, css: string) => {
      seen.add(css)
      return ''
    })
  )
  return { glossaries: stripped, css: [...seen].join('\n') }
}
