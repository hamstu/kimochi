/**
 * Settings → Language: the short notes about a language, from the traits in `ui/languages.ts`
 * only (tested in scripts/language-picker.test.mjs). Each says what Kimochi assumes about the
 * language's text; nothing here promises a feature.
 */
import type { Language, ScriptCode } from '@ui/languages'

const SCRIPT_NAMES: Record<ScriptCode, string> = {
  Jpan: 'kanji and kana',
  Kore: 'Hangul',
  Hans: 'simplified Chinese characters',
  Hant: 'traditional Chinese characters',
  Latn: 'the Latin alphabet',
  Cyrl: 'the Cyrillic alphabet',
  Grek: 'the Greek alphabet',
  Deva: 'Devanagari',
  Thai: 'the Thai script',
  Geor: 'the Georgian script',
  Armn: 'the Armenian alphabet',
  Khmr: 'the Khmer script',
  Laoo: 'the Lao script',
  Knda: 'the Kannada script'
}

const list = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`

export function languageNotes(language: Pick<Language, 'scripts' | 'spaces' | 'vertical' | 'ruby'>): string[] {
  const notes = [`Written in ${list(language.scripts.map((script) => SCRIPT_NAMES[script]))}.`]
  notes.push(language.spaces ? 'Words are separated by spaces.' : 'Words are written without spaces between them.')
  if (language.vertical) notes.push('Vertical text is looked for as well as horizontal.')
  if (language.ruby) notes.push('Furigana, the small readings beside kanji, can be filtered out of scans.')
  return notes
}
