/** The Log footer's ⋯ menu: which stats the footer shows, the session's reset actions, exporting
    what was read, settings. */
import { useEffect, useState } from 'react'
import { Download, Ellipsis, Eraser, RotateCcw, Settings } from 'lucide-react'
import {
  IconButton,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Tooltip
} from '@kit'
import { getSettings, onSettingsChange, updateSettings } from '@texthooker/lib/settings'
import type { Settings as ReaderSettings } from '@texthooker/lib/types'
import { useLogActions } from '../../main/logActions'
import { openSettings } from '../../bridge/tauri'
import { useLanguage } from '../../bridge/useLanguage'
import { exportReadingHistory, HISTORY_FORMATS } from '@texthooker/lib/readingHistory'

const STATS = [
  { key: 'statsShowTime', label: 'Reading time' },
  { key: 'statsShowLines', label: 'Line count' },
  { key: 'statsShowChars', label: 'Character count' },
  { key: 'statsShowSpeed', label: 'Reading speed' }
] as const satisfies readonly { key: keyof ReaderSettings; label: string }[]

export function LogMoreMenu() {
  const [settings, setSettings] = useState(getSettings)
  const actions = useLogActions()
  // A language that spaces its words counts words (StatsFooter).
  const [language] = useLanguage()
  useEffect(() => onSettingsChange(setSettings), [])

  return (
    <Menu>
      <Tooltip content="More">
        <MenuTrigger asChild>
          <IconButton label="More" size="sm">
            <Ellipsis />
          </IconButton>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" side="top" className="log-more-menu">
        <MenuLabel>Show in footer</MenuLabel>
        {STATS.map((stat) => (
          <MenuCheckboxItem
            key={stat.key}
            checked={settings[stat.key]}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(value) => void updateSettings({ [stat.key]: value })}
          >
            {stat.key === 'statsShowChars' && language.spaces ? 'Word count' : stat.label}
          </MenuCheckboxItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Eraser />} onSelect={actions.clearLines}>
          Clear lines…
        </MenuItem>
        <MenuItem icon={<RotateCcw />} onSelect={actions.resetStats}>
          Reset stats…
        </MenuItem>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger icon={<Download />}>Export reading history</MenuSubTrigger>
          <MenuSubContent>
            {HISTORY_FORMATS.map((choice) => (
              <MenuItem key={choice.format} onSelect={() => void exportReadingHistory(choice.format)}>
                {choice.label}…
              </MenuItem>
            ))}
          </MenuSubContent>
        </MenuSub>
        <MenuSeparator />
        <MenuItem icon={<Settings />} onSelect={() => void openSettings('log')}>
          Log settings…
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
