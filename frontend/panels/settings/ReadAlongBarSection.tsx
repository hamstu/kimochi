/**
 * Settings → Overlay → Read along bar: the strip Read along shows beside the text (where you are,
 * which buttons do what), whether it shows, its position counter and its shortcut hints
 * (`readAlongBar`, ui/read-along-bar.js). Where it goes is not a setting: outside a window source
 * where there's room, inside a full-screen one, and never over the line being read.
 */
import type { ReactNode } from 'react'
import { Segmented, SettingsRow, SettingsSection, Switch, type SegmentOption } from '@kit'
import { DEFAULT_READ_ALONG_BAR, type ReadAlongBarHints, type ReadAlongBarSettings } from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'

const HINTS: readonly SegmentOption<ReadAlongBarHints>[] = [
  { value: 'all', label: 'All' },
  { value: 'basic', label: 'Basics' },
  { value: 'none', label: 'None' }
]

const HINTS_DETAIL: Record<ReadAlongBarHints, string> = {
  all: 'Every button Read along uses.',
  basic: 'Moving, looking up and going back.',
  none: 'No buttons, only what you’re doing.'
}

export function ReadAlongBarSection(): ReactNode {
  const [stored, setStored] = useSetting<Partial<ReadAlongBarSettings>>('readAlongBar', DEFAULT_READ_ALONG_BAR)
  const bar: ReadAlongBarSettings = { ...DEFAULT_READ_ALONG_BAR, ...stored }
  const hints: ReadAlongBarHints = HINTS.some((option) => option.value === bar.hints) ? bar.hints : 'all'
  const save = (change: Partial<ReadAlongBarSettings>): void => void setStored({ ...bar, ...change })

  return (
    <SettingsSection
      title="Read along bar"
      description="The bar beside the text while you read along. It sits outside a game’s window when there’s room, and never covers the line you’re reading."
    >
      <SettingsRow label="Show the bar" controlId="read-along-bar-shown">
        <Switch id="read-along-bar-shown" checked={bar.shown} onCheckedChange={(checked) => save({ shown: checked })} />
      </SettingsRow>
      {bar.shown && (
        <>
          <SettingsRow
            label="Position"
            controlId="read-along-bar-counter"
            description="Which word you’re on, as in 9 / 13."
          >
            <Switch
              id="read-along-bar-counter"
              checked={bar.counter}
              onCheckedChange={(checked) => save({ counter: checked })}
            />
          </SettingsRow>
          <SettingsRow label="Shortcut hints" description={HINTS_DETAIL[hints]}>
            <Segmented
              aria-label="Shortcut hints"
              value={hints}
              onValueChange={(value) => save({ hints: value })}
              options={HINTS}
            />
          </SettingsRow>
        </>
      )}
    </SettingsSection>
  )
}
