/**
 * The language picker's search, as a pure function (tested in scripts/language-picker.test.mjs):
 * a language matches by its English name or its endonym, ignoring case and accents ("espanol"),
 * or by the start of its code ("zh" finds both Chinese scripts, "pt" Portuguese).
 */
import type { Language } from '@ui/languages'
import { comboboxMatches, foldText } from '../kit/comboboxFilter'

export function languageMatches(language: Pick<Language, 'code' | 'name' | 'endonym'>, query: string): boolean {
  const folded = foldText(query.trim())
  if (!folded) return true
  return comboboxMatches([language.name, language.endonym], folded) || language.code.toLowerCase().startsWith(folded)
}
