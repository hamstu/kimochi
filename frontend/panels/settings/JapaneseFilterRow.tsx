/**
 * The line filter: one setting (the Log's `japaneseFilter`) that the Log and the overlay both
 * apply (ui/japanese-text.ts), shown in both of their settings pages. A row only: the page puts it
 * in its own section.
 *
 * Named for the language being read (`useLanguage`): "No Korean", "Mostly not Korean". A language
 * written only in the Latin alphabet is named by what the rule then keeps, letters, since its
 * name would claim more than a script can tell (English and French share every letter).
 */
import type { ReactNode } from 'react'
import { SettingsRow, StepSlider, type StepOption } from '@kit'
import { updateSettings } from '@texthooker/lib/settings'
import { useLanguage } from '../../bridge/useLanguage'
import { japaneseFilterOf, type JapaneseFilterMode } from '@ui/japanese-text'
import type { Language } from '@ui/languages'
import { WithReaderSettings } from './ReaderSettingsProvider'

interface Wording {
  steps: readonly StepOption<JapaneseFilterMode>[]
  detail: Record<JapaneseFilterMode, string>
}

/** The row's steps (least to most strict) and what each does, for the language being read. */
function filterWording(language: Pick<Language, 'name' | 'scripts'>): Wording {
  const letters = language.scripts.length > 0 && language.scripts.every((script) => script === 'Latn')
  const what = letters ? 'letters' : language.name
  return {
    steps: [
      { value: 'off', label: 'Off' },
      { value: 'noJapanese', label: `No ${what}` },
      { value: 'mostlyNonJapanese', label: `Mostly not ${what}` }
    ],
    detail: {
      off: 'Every line is kept.',
      noJapanese: `Lines without ${what} are dropped.`,
      mostlyNonJapanese: letters
        ? 'Also drops lines that are mostly numbers and symbols, like OCR noise.'
        : `Also drops lines with only a little ${what}, like OCR noise.`
    }
  }
}

export function JapaneseFilterRow(): ReactNode {
  const [language] = useLanguage()
  const { steps, detail } = filterWording(language)
  return (
    <WithReaderSettings>
      {(settings) => {
        const mode = japaneseFilterOf(settings).japaneseFilter
        return (
          <SettingsRow label="Drop lines" description={detail[mode]} stacked>
            <StepSlider
              aria-label="Drop lines"
              value={mode}
              onValueChange={(japaneseFilter) => void updateSettings({ japaneseFilter })}
              options={steps}
            />
          </SettingsRow>
        )
      }}
    </WithReaderSettings>
  )
}
