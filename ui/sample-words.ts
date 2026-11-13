/**
 * One everyday word per language, for the dictionary guide's practice lookup ("Test a lookup of
 * 日本語"): a noun any general dictionary of the language has, in its dictionary form. Languages
 * not listed get no practice lookup. Keys are codes from `ui/languages.ts`.
 */
const SAMPLE_WORDS: Readonly<Record<string, string>> = {
  ja: '日本語',
  ko: '한국어',
  'zh-Hans': '中文',
  'zh-Hant': '中文',
  yue: '廣東話',
  en: 'house',
  es: 'casa',
  fr: 'maison',
  de: 'Haus',
  it: 'casa',
  pt: 'casa',
  ru: 'дом',
  hi: 'घर',
  th: 'บ้าน',
  vi: 'nhà',
  id: 'rumah',
  tr: 'ev',
  pl: 'dom',
  nl: 'huis',
  sv: 'hus',
  no: 'hus',
  da: 'hus',
  fi: 'talo',
  el: 'σπίτι',
  uk: 'дім',
  cs: 'dům'
}

/** The practice word for a language, or null when there is none. */
export function sampleWord(code: string): string | null {
  return Object.hasOwn(SAMPLE_WORDS, code) ? SAMPLE_WORDS[code] : null
}

/** "a Japanese dictionary", "an English dictionary", for copy that names the language's dictionary. */
export function aDictionaryFor(languageName: string): string {
  return `${/^[AEIO]/.test(languageName) ? 'an' : 'a'} ${languageName} dictionary`
}
