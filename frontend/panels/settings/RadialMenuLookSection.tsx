/**
 * Settings → Overlay → Radial menu: how the radial menu looks over a game. A picture of the menu
 * as it opens with an OCR source (`RadialPreview`, not editable here) and its colour
 * (`radialMenuColor`, its own; the highlight colour until one is chosen). What it holds and its
 * shortcuts are edited in Settings → Shortcuts & Controls → Radial menu, which Configure radial
 * menu opens.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Button, SettingsSection } from '@kit'
import { effectiveRadialMenu, RADIAL_MENU_SETTING } from '@ui/radial-items.js'
import { useSetting } from '../../bridge/useSetting'
import { RADIAL_MENU_SECTION, requestSettingsSection } from '../../bridge/settingsTarget'
import { ColourSwatches } from './ColourSwatches'
import { RadialPreview } from './RadialMenuSection'
import { shownRadialItems, useRadialMenuColor, useRadialShortcuts } from './radialMenuPreview'
import { showSettingsTab } from './showSettingsTab'
import './overlay-look.css'
import './radial-menu-section.css'

export function RadialMenuLookSection(): ReactNode {
  const [stored] = useSetting<string[] | null>(RADIAL_MENU_SETTING, null)
  const [, setColor] = useSetting<string | null>('radialMenuColor', null)
  const saved = useRadialMenuColor()
  const items = useMemo(() => shownRadialItems(effectiveRadialMenu(stored), 'ocr'), [stored])
  const details = useRadialShortcuts()
  const id = useId()
  // The custom picker reports every movement: the ring follows at once, the setting once it rests.
  const [draft, setDraft] = useState<string | null>(null)
  const color = draft ?? saved
  useEffect(() => {
    if (draft === null) return
    const timer = setTimeout(() => {
      setDraft(null)
      if (draft !== saved) void setColor(draft)
    }, 250)
    return () => clearTimeout(timer)
  }, [draft, saved, setColor])

  const configure = (): void => {
    requestSettingsSection(RADIAL_MENU_SECTION)
    showSettingsTab('controls')
  }

  return (
    <SettingsSection
      title="Radial menu"
      description="The menu you open over a game with its shortcut or a controller button."
    >
      <div className="radial-look-stage">
        <RadialPreview items={items} selected={null} details={details} color={color} interactive={false} />
      </div>
      <div className="radial-look-row">
        <div className="radial-look-colour">
          <span className="overlay-look-label" id={`${id}-colour`}>
            Colour
          </span>
          <ColourSwatches
            value={color}
            label="radial menu colour"
            labelledBy={`${id}-colour`}
            onChoose={(value) => {
              setDraft(null)
              if (value !== saved) void setColor(value)
            }}
            onDraft={setDraft}
          />
        </div>
        <Button size="sm" onClick={configure}>
          Configure radial menu
        </Button>
      </div>
    </SettingsSection>
  )
}
