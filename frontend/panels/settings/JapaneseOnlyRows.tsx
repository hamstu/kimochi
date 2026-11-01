/**
 * "Japanese only" and its stricter mode: one setting (the Log's `cjkOnly` and `cjkOnlyLatinEdges`)
 * that the Log and the overlay both apply (ui/japanese-text.ts), shown in both of their settings
 * pages. Rows only: the page puts them in its own section.
 */
import type { ReactNode } from 'react'
import { SettingsRow, SettingsSubgroup, Switch } from '@kit'
import { updateSettings } from '@texthooker/lib/settings'
import { WithReaderSettings } from './ReaderSettingsProvider'

export function JapaneseOnlyRows({ idPrefix }: { idPrefix: string }): ReactNode {
  return (
    <WithReaderSettings>
      {(settings) => (
        <>
          <SettingsRow
            label="Japanese only"
            controlId={`${idPrefix}-cjk`}
            description="Drop lines with no Japanese characters, in the Log and on the overlay."
          >
            <Switch
              id={`${idPrefix}-cjk`}
              checked={settings.cjkOnly}
              onCheckedChange={(v) => void updateSettings({ cjkOnly: v })}
            />
          </SettingsRow>
          {settings.cjkOnly ? (
            <SettingsSubgroup>
              <SettingsRow
                label="Also drop lines that start or end in English"
                controlId={`${idPrefix}-cjk-edges`}
                description="Drops lines whose first or last letter is a Roman one, like English menu items with a little Japanese in them. Can drop real lines too, such as one starting with HP."
              >
                <Switch
                  id={`${idPrefix}-cjk-edges`}
                  checked={settings.cjkOnlyLatinEdges}
                  onCheckedChange={(v) => void updateSettings({ cjkOnlyLatinEdges: v })}
                />
              </SettingsRow>
            </SettingsSubgroup>
          ) : null}
        </>
      )}
    </WithReaderSettings>
  )
}
