/**
 * Settings → Overlay → Radial menu: how the radial menu looks over a game. A picture of the menu
 * as it opens with an OCR source (`RadialPreview`, not editable here), its accent colour
 * (`radialMenuColor`: the highlight colour until one is chosen) and its base, the ring behind the
 * icons (`radialMenuBase`: a colour and how opaque). What it holds and its shortcuts are edited in
 * Settings → Shortcuts & Controls → Radial menu, which Configure radial menu opens.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Button, SettingsSection, Slider } from '@kit'
import { effectiveRadialMenu, RADIAL_MENU_SETTING } from '@ui/radial-items.js'
import { RADIAL_BASE_PRESETS } from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { RADIAL_MENU_SECTION, requestSettingsSection } from '../../bridge/settingsTarget'
import { ColourSwatches } from './ColourSwatches'
import { OpacityScale } from './OverlayLook'
import { RadialPreview } from './RadialMenuSection'
import { shownRadialItems, useRadialMenuBase, useRadialMenuColor, useRadialShortcuts } from './radialMenuPreview'
import { showSettingsTab } from './showSettingsTab'
import './overlay-look.css'
import './radial-menu-section.css'

const MIN_BASE_OPACITY = 10

/**
 * A colour the custom picker drags: the preview follows `draft` at once, and `save` gets it once
 * the picker rests.
 */
function useColourDraft(saved: string, save: (value: string) => void): [string, (value: string | null) => void] {
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => {
    if (draft === null) return
    const timer = setTimeout(() => {
      setDraft(null)
      if (draft !== saved) save(draft)
    }, 250)
    return () => clearTimeout(timer)
  }, [draft, saved, save])
  return [draft ?? saved, setDraft]
}

export function RadialMenuLookSection(): ReactNode {
  const [stored] = useSetting<string[] | null>(RADIAL_MENU_SETTING, null)
  const [, setAccent] = useSetting<string | null>('radialMenuColor', null)
  const savedAccent = useRadialMenuColor()
  const [base, setBase] = useRadialMenuBase()
  const items = useMemo(() => shownRadialItems(effectiveRadialMenu(stored), 'ocr'), [stored])
  const details = useRadialShortcuts()
  const id = useId()
  const [accent, setAccentDraft] = useColourDraft(savedAccent, (value) => void setAccent(value))
  const [baseColor, setBaseDraft] = useColourDraft(base.color, (color) => setBase({ ...base, color }))

  const configure = (): void => {
    requestSettingsSection(RADIAL_MENU_SECTION)
    showSettingsTab('controls')
  }
  // The opacity is saved as the thumb moves (in steps of 5), so the ring follows it live.
  const chooseOpacity = (opacity: number): void => {
    if (opacity !== base.opacity) setBase({ ...base, opacity })
  }

  return (
    <SettingsSection
      title="Radial menu"
      description="The menu you open over a game with its shortcut or a controller button."
    >
      <RadialPreview
        items={items}
        selected={null}
        details={details}
        color={accent}
        base={{ color: baseColor, opacity: base.opacity }}
        interactive={false}
      />
      <div className="radial-look-row">
        <div className="radial-look-field">
          <span className="overlay-look-label" id={`${id}-accent`}>
            Accent colour
          </span>
          <ColourSwatches
            value={accent}
            label="accent colour"
            labelledBy={`${id}-accent`}
            onChoose={(value) => {
              setAccentDraft(null)
              if (value !== savedAccent) void setAccent(value)
            }}
            onDraft={setAccentDraft}
            inline
          />
        </div>
        <Button size="sm" onClick={configure}>
          Configure radial menu
        </Button>
      </div>
      <div className="radial-look-row">
        <div className="radial-look-field">
          <span className="overlay-look-label" id={`${id}-base`}>
            Base colour
          </span>
          <ColourSwatches
            value={baseColor}
            label="base colour"
            labelledBy={`${id}-base`}
            presets={RADIAL_BASE_PRESETS}
            onChoose={(color) => {
              setBaseDraft(null)
              if (color !== base.color) setBase({ ...base, color })
            }}
            onDraft={setBaseDraft}
            inline
          />
        </div>
        <div className="radial-look-field">
          <span className="overlay-look-label">Base opacity</span>
          <div className="overlay-look-opacity-control radial-look-opacity">
            <Slider
              aria-label="Base opacity"
              valueText={(percent) => `${percent}%`}
              value={[base.opacity]}
              onValueChange={(values) => chooseOpacity(values[0])}
              min={MIN_BASE_OPACITY}
              max={100}
              step={5}
            />
            <OpacityScale value={base.opacity} min={MIN_BASE_OPACITY} onChoose={chooseOpacity} />
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}
