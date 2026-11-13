/**
 * The language being read (the top-level `language` setting), as the Log's own code reads it:
 * at once, from a copy kept current by the settings event, so ingest (the line filter) and the
 * shift-scan (word starts) never wait on a round trip. The host loads it before the first line
 * arrives (`startHost`); until then, and if it cannot be read, it is Japanese.
 */
import { DEFAULT_LANGUAGE, languageOf, type Language } from '@ui/languages'
import { getSetting, onSettingsChange } from '../../bridge/settings'

let code: string = DEFAULT_LANGUAGE
let loading: Promise<void> | null = null

/** Reads the setting once and follows it from then on. */
export function loadLanguage(): Promise<void> {
  if (!loading)
    loading = (async () => {
      onSettingsChange((key, value) => {
        if (key === 'language') code = languageOf(value).code
      })
      code = languageOf(await getSetting<string>('language', DEFAULT_LANGUAGE)).code
    })().catch((error) => {
      console.error('[language] could not read the language setting:', error)
    })
  return loading
}

/** The language's code now. */
export const currentLanguage = (): string => code

/** The language's row in languages.ts now. */
export const currentLanguageInfo = (): Language => languageOf(code)
