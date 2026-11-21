/**
 * Cyrillic and Greek letters that OCR reads in place of Latin ones they look exactly like.
 *
 * A multilingual engine (Screen AI above all) picks each letter's alphabet from its pixels, and
 * where two alphabets draw a letter the same it sometimes picks the wrong one: `estrellа` with a
 * Cyrillic `а` (U+0430) for the Latin `a`, `cebollа` the same. On screen nothing is wrong, but no
 * Spanish dictionary has a word with a Cyrillic letter in it, so the word is never found.
 *
 * In a language written only in the Latin alphabet, a word made of Latin letters and these
 * lookalikes is a Latin word: its lookalikes are put back. A word with any other Cyrillic or Greek
 * letter in it is left as it is (a Russian name or a Greek quote in a Spanish game). One letter
 * for one, so every offset and box measured on the text still holds.
 */
import { languageOf } from './languages.js'

/** Each lookalike and the Latin letter it stands for: those drawn the same in common fonts. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  // Cyrillic, lower case.
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  һ: 'h',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ӏ: 'l',
  // Cyrillic, upper case.
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  У: 'Y',
  І: 'I',
  Ј: 'J',
  Ѕ: 'S',
  Ԛ: 'Q',
  Ԝ: 'W',
  // Greek: the capitals, and the small omicron.
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
  ο: 'o'
}

const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'u')
/** A word: letters and their marks (an accent read as a mark of its own stays with its letter). */
const WORD = /[\p{L}\p{M}]+/gu
const LATIN_OR_MARK = /[\p{Script=Latin}\p{M}]/u

/** Whether every letter of `word` is Latin or a lookalike, and at least one is a lookalike. */
function isLatinWithLookalikes(word: string): boolean {
  let found = false
  for (const c of word) {
    if (LOOKALIKES[c] !== undefined) found = true
    else if (!LATIN_OR_MARK.test(c)) return false
  }
  return found
}

/** `text` with the lookalikes in its Latin words put back. Unchanged when it has none. */
export function restoreLatinLookalikes(text: string): string {
  if (!LOOKALIKE.test(text)) return text
  return text.replace(WORD, (word) =>
    isLatinWithLookalikes(word) ? [...word].map((c) => LOOKALIKES[c] ?? c).join('') : word
  )
}

/**
 * `restoreLatinLookalikes` for a language written only in the Latin alphabet (Spanish, French,
 * German…), or null for any other: Russian or Greek text is its own, and Serbo-Croatian is written
 * in both alphabets.
 */
export function latinLookalikeFixer(language?: string): ((text: string) => string) | null {
  const { scripts } = languageOf(language)
  return scripts.length === 1 && scripts[0] === 'Latn' ? restoreLatinLookalikes : null
}
