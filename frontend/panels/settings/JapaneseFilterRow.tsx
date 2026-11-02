/**
 * The Japanese filter: one setting (the Log's `japaneseFilter`) that the Log and the overlay both
 * apply (ui/japanese-text.ts), shown in both of their settings pages. A row only: the page puts it
 * in its own section.
 */
import type { ReactNode } from 'react'
import { SettingsRow, StepSlider, type StepOption } from '@kit'
import { updateSettings } from '@texthooker/lib/settings'
import { japaneseFilterOf, type JapaneseFilterMode } from '@ui/japanese-text'
import { WithReaderSettings } from './ReaderSettingsProvider'

// Least to most strict.
const STEPS: readonly StepOption<JapaneseFilterMode>[] = [
  { value: 'off', label: 'Off' },
  { value: 'noJapanese', label: 'No Japanese' },
  { value: 'mostlyNonJapanese', label: 'Mostly not Japanese' }
]

const DETAIL: Record<JapaneseFilterMode, string> = {
  off: 'Every line is kept.',
  noJapanese: 'Lines without Japanese are dropped.',
  mostlyNonJapanese: 'Also drops lines with only a little Japanese, like OCR noise.'
}

export function JapaneseFilterRow(): ReactNode {
  return (
    <WithReaderSettings>
      {(settings) => {
        const mode = japaneseFilterOf(settings).japaneseFilter
        return (
          <SettingsRow label="Drop lines" description={DETAIL[mode]} stacked>
            <StepSlider
              aria-label="Drop lines"
              value={mode}
              onValueChange={(japaneseFilter) => void updateSettings({ japaneseFilter })}
              options={STEPS}
            />
          </SettingsRow>
        )
      }}
    </WithReaderSettings>
  )
}
