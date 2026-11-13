/**
 * The language being learned (the `language` setting), as the panels read it: the row from
 * `ui/languages.ts`, live across windows, and the setter the pickers use.
 */
import { DEFAULT_LANGUAGE, languageOf, type Language } from '@ui/languages'
import { useSetting } from './useSetting'

export function useLanguage(): [Language, (code: string) => Promise<void>] {
  const [code, setCode] = useSetting<string>('language', DEFAULT_LANGUAGE)
  return [languageOf(code), setCode]
}
