/**
 * The combobox's search, as a pure function: whether any of an option's texts contains the query,
 * ignoring case and accents ("espanol" finds "Español", "francais" finds "Français"), with each
 * word of the query matched on its own ("chinese trad" finds "Chinese (Traditional)").
 */

/** Lower case, without combining marks; other scripts are left as they are. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

export function comboboxMatches(texts: readonly string[], query: string): boolean {
  const words = foldText(query).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = texts.map(foldText)
  return words.every((word) => haystack.some((text) => text.includes(word)))
}
