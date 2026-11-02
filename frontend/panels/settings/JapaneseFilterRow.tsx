/**
 * The Japanese filter: one setting (the Log's `japaneseFilter`) that the Log and the overlay both
 * apply (ui/japanese-text.ts), shown in both of their settings pages. A row only: the page puts it
 * in its own section.
 */
import type { ReactNode } from 'react'
import { Select, SettingsRow, type SelectOption } from '@kit'
import { updateSettings } from '@texthooker/lib/settings'
import { japaneseFilterOf, type JapaneseFilterMode } from '@ui/japanese-text'
import { WithReaderSettings } from './ReaderSettingsProvider'

const OPTIONS: readonly SelectOption<JapaneseFilterMode>[] = [
  { value: 'noJapanese', label: 'With no Japanese', detail: 'Default' },
  { value: 'mostlyNonJapanese', label: 'Mostly not Japanese' },
  { value: 'off', label: 'Off' }
]

export function JapaneseFilterRow(): ReactNode {
  return (
    <WithReaderSettings>
      {(settings) => (
        <SettingsRow
          label="Drop lines"
          description="Skip lines that aren't Japanese, in the Log and on the overlay. Mostly not Japanese also drops lines with only a little Japanese in them, such as OCR junk or English menus."
        >
          <Select
            aria-label="Drop lines"
            value={japaneseFilterOf(settings).japaneseFilter}
            onValueChange={(japaneseFilter) => void updateSettings({ japaneseFilter })}
            options={OPTIONS}
          />
        </SettingsRow>
      )}
    </WithReaderSettings>
  )
}
