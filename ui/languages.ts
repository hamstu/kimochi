/**
 * The languages Kimochi can be set to read (the `language` setting), and what the app needs to
 * know about each: the scripts it is written in, whether words are separated by spaces, whether
 * it is set vertically, and whether it carries ruby (furigana). Everything that used to assume
 * Japanese asks this table instead, and with `ja` every answer is what the app did before.
 *
 * The native side reads the same facts from `src-tauri/languages.json`
 * (`scripts/languages.test.mjs` keeps the two in step).
 *
 * Codes are BCP 47: the language subtag alone, with a script subtag only for Chinese. Spellings
 * follow Yomitan's where they differ (`tl`, `no`, `sh`). Right-to-left languages are not listed
 * yet: the overlay cannot lay them out.
 */

/** ISO 15924, with the two combined codes (`Jpan`, `Kore`) for scripts used together. */
export type ScriptCode =
  | 'Jpan'
  | 'Kore'
  | 'Hans'
  | 'Hant'
  | 'Latn'
  | 'Cyrl'
  | 'Grek'
  | 'Deva'
  | 'Thai'
  | 'Geor'
  | 'Armn'
  | 'Khmr'
  | 'Laoo'
  | 'Knda'

export interface Language {
  code: string
  /** In English. */
  name: string
  /** In the language itself. */
  endonym: string
  scripts: readonly ScriptCode[]
  /** Words are separated by spaces. */
  spaces: boolean
  /** Vertical setting is in real use, so vertical text is looked for. */
  vertical: boolean
  /** Small annotation text (furigana) sits beside the main text. */
  ruby: boolean
  /** A `circle-flags` name, or null for a badge with the code. */
  flag: string | null
}

type Row = [
  code: string,
  name: string,
  endonym: string,
  scripts: ScriptCode | readonly ScriptCode[],
  flag: string | null,
  traits?: { spaces?: boolean; vertical?: boolean; ruby?: boolean }
]

const CJK = { spaces: false, vertical: true }
const UNSPACED = { spaces: false }

// Japanese first (the default and the one fully supported), then Korean and Chinese, then by how
// many people learn each.
const ROWS: readonly Row[] = [
  ['ja', 'Japanese', '日本語', 'Jpan', 'jp', { ...CJK, ruby: true }],
  ['ko', 'Korean', '한국어', 'Kore', 'kr'],
  ['zh-Hans', 'Chinese (Simplified)', '简体中文', 'Hans', 'cn', CJK],
  ['zh-Hant', 'Chinese (Traditional)', '繁體中文', 'Hant', 'tw', CJK],
  ['yue', 'Cantonese', '粵語', 'Hant', 'hk', CJK],
  ['en', 'English', 'English', 'Latn', 'us'],
  ['es', 'Spanish', 'Español', 'Latn', 'es'],
  ['fr', 'French', 'Français', 'Latn', 'fr'],
  ['de', 'German', 'Deutsch', 'Latn', 'de'],
  ['it', 'Italian', 'Italiano', 'Latn', 'it'],
  ['pt', 'Portuguese', 'Português', 'Latn', 'br'],
  ['ru', 'Russian', 'Русский', 'Cyrl', 'ru'],
  ['hi', 'Hindi', 'हिन्दी', 'Deva', 'in'],
  ['th', 'Thai', 'ไทย', 'Thai', 'th', UNSPACED],
  ['vi', 'Vietnamese', 'Tiếng Việt', 'Latn', 'vn'],
  ['id', 'Indonesian', 'Bahasa Indonesia', 'Latn', 'id'],
  ['tr', 'Turkish', 'Türkçe', 'Latn', 'tr'],
  ['pl', 'Polish', 'Polski', 'Latn', 'pl'],
  ['nl', 'Dutch', 'Nederlands', 'Latn', 'nl'],
  ['sv', 'Swedish', 'Svenska', 'Latn', 'se'],
  ['no', 'Norwegian', 'Norsk', 'Latn', 'no'],
  ['da', 'Danish', 'Dansk', 'Latn', 'dk'],
  ['fi', 'Finnish', 'Suomi', 'Latn', 'fi'],
  ['el', 'Greek', 'Ελληνικά', 'Grek', 'gr'],
  ['uk', 'Ukrainian', 'Українська', 'Cyrl', 'ua'],
  ['cs', 'Czech', 'Čeština', 'Latn', 'cz'],
  ['hu', 'Hungarian', 'Magyar', 'Latn', 'hu'],
  ['ro', 'Romanian', 'Română', 'Latn', 'ro'],
  ['tl', 'Tagalog', 'Tagalog', 'Latn', 'ph'],
  ['la', 'Latin', 'Latina', 'Latn', 'va'],
  ['bg', 'Bulgarian', 'Български', 'Cyrl', 'bg'],
  ['sh', 'Serbo-Croatian', 'Srpskohrvatski', ['Latn', 'Cyrl'], null],
  ['ga', 'Irish', 'Gaeilge', 'Latn', 'ie'],
  ['cy', 'Welsh', 'Cymraeg', 'Latn', 'gb-wls'],
  ['eo', 'Esperanto', 'Esperanto', 'Latn', 'language/eo'],
  ['ka', 'Georgian', 'ქართული', 'Geor', 'ge'],
  ['hy', 'Armenian', 'Հայերեն', 'Armn', 'am'],
  ['km', 'Khmer', 'ខ្មែរ', 'Khmr', 'kh', UNSPACED],
  ['lo', 'Lao', 'ລາວ', 'Laoo', 'la', UNSPACED],
  ['mn', 'Mongolian', 'Монгол', 'Cyrl', 'mn'],
  ['kn', 'Kannada', 'ಕನ್ನಡ', 'Knda', 'in'],
  ['et', 'Estonian', 'Eesti', 'Latn', 'ee'],
  ['lv', 'Latvian', 'Latviešu', 'Latn', 'lv'],
  ['sq', 'Albanian', 'Shqip', 'Latn', 'al'],
  ['be', 'Belarusian', 'Беларуская', 'Cyrl', 'by'],
  ['eu', 'Basque', 'Euskara', 'Latn', 'es-pv'],
  ['gd', 'Scottish Gaelic', 'Gàidhlig', 'Latn', 'gb-sct'],
  ['mt', 'Maltese', 'Malti', 'Latn', 'mt'],
  ['grc', 'Ancient Greek', 'Ἑλληνική', 'Grek', 'gr']
]

export const LANGUAGES: readonly Language[] = ROWS.map(([code, name, endonym, scripts, flag, traits]) => ({
  code,
  name,
  endonym,
  scripts: typeof scripts === 'string' ? [scripts] : scripts,
  spaces: traits?.spaces ?? true,
  vertical: traits?.vertical ?? false,
  ruby: traits?.ruby ?? false,
  flag
}))

export const DEFAULT_LANGUAGE = 'ja'
export const LANGUAGE_CODES: readonly string[] = LANGUAGES.map((language) => language.code)

const BY_CODE = new Map(LANGUAGES.map((language) => [language.code, language]))
const JAPANESE = BY_CODE.get(DEFAULT_LANGUAGE) as Language

/** The language for a stored code; anything this build does not list reads as Japanese. */
export function languageOf(code: unknown): Language {
  return (typeof code === 'string' && BY_CODE.get(code)) || JAPANESE
}

/** Whether the code is Japanese, or reads as it (see `languageOf`). */
export function isJapanese(code: unknown): boolean {
  return languageOf(code) === JAPANESE
}
