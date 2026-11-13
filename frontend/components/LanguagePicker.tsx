/**
 * The language being learned, chosen from `ui/languages.ts`: each row its flag, English name and
 * endonym; the search matches either name or the code (`languageMatches`). Settings → Language
 * shows it as a select with a search field; the welcome guide shows it `inline`, a list to scroll
 * and tap with the search above it.
 */
import { useMemo, type ReactNode } from 'react'
import { Combobox, type ComboboxOption } from '@kit'
import { LANGUAGES, languageOf } from '@ui/languages'
import { LanguageFlag } from './LanguageFlag'
import { languageMatches } from './languageSearch'
import './language-picker.css'

export function LanguagePicker({
  value,
  onValueChange,
  inline,
  className,
  disabled
}: {
  value: string
  onValueChange: (code: string) => void
  inline?: boolean
  className?: string
  disabled?: boolean
}): ReactNode {
  const options = useMemo<ComboboxOption<string>[]>(
    () =>
      LANGUAGES.map((language) => ({
        value: language.code,
        label: language.name,
        icon: <LanguageFlag language={language} />,
        detail:
          language.endonym === language.name ? undefined : (
            <span lang={language.code}>{language.endonym}</span>
          ),
        keywords: [language.endonym, language.code]
      })),
    []
  )
  return (
    <Combobox
      aria-label="Language you are learning"
      className={['language-picker', inline && 'language-picker-inline', className].filter(Boolean).join(' ')}
      value={languageOf(value).code}
      onValueChange={onValueChange}
      options={options}
      filter={(option, query) => languageMatches(languageOf(option.value), query)}
      searchPlaceholder="Search languages"
      emptyText="No language by that name yet"
      inline={inline}
      disabled={disabled}
    />
  )
}
