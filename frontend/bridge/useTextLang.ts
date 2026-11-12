/**
 * The `lang` attribute for the learner's text (Log lines, looked-up words, notebook names, hooked
 * text): the language being read, as a BCP 47 code (ui/language-style.ts); `ja` for Japanese, as
 * every such element carried before the language setting existed. The font that goes with it is
 * `--k-font-text` (kit/tokens.css), which `useTextFont` keeps pointed at the language.
 */
import { useEffect } from 'react'
import { applyTextStyle, textLang } from '@ui/language-style'
import { useLanguage } from './useLanguage'

export function useTextLang(): string {
  const [language] = useLanguage()
  return textLang(language.code)
}

/**
 * Points the window's `--k-font-text` (and overlay-text.css's font) at the language being read:
 * nothing for Japanese, so it is drawn exactly as before. Once per window (entries/providers.tsx).
 */
export function useTextFont(): void {
  const [language] = useLanguage()
  useEffect(() => applyTextStyle(language.code), [language.code])
}
