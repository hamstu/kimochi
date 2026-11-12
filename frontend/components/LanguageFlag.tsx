/**
 * A language's picture: its round flag (`flag` in `ui/languages.ts`, from `circle-flags`), or a
 * neutral round badge with its code where the table names no flag (Serbo-Croatian) or a name has
 * no picture. Never an emoji flag: Windows has none. Decorative, since the name always sits beside
 * it. Sized by `--language-flag-size` (the row icon size, 16 px, by default).
 */
import type { ReactNode } from 'react'
import type { Language } from '@ui/languages'
import { flagUrl } from './languageFlags'
import './language-flag.css'

export function LanguageFlag({
  language,
  className
}: {
  language: Pick<Language, 'code' | 'flag'>
  className?: string
}): ReactNode {
  const classes = ['language-flag', className].filter(Boolean).join(' ')
  const src = flagUrl(language.flag)
  if (src) return <img className={classes} src={src} alt="" aria-hidden draggable={false} />
  return (
    <span className={`${classes} language-flag-badge`} aria-hidden>
      {language.code.split('-')[0].slice(0, 3)}
    </span>
  )
}
