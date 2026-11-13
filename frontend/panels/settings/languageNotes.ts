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

/**
 * The sentence that says Kimochi changed the OCR engine when the language changed (native
 * `follow_language`): `from` and `to` are engine names, `fromReads` whether the engine left can
 * read the new language (it can when the one last used for the language came back).
 */
export function engineSwitchNote(from: string, to: string, languageName: string, fromReads: boolean): string {
  return fromReads
    ? `Kimochi switched back to ${to}, the engine you last used for ${languageName}.`
    : `Kimochi switched to ${to}, because ${from} can't read ${languageName}.`
}
