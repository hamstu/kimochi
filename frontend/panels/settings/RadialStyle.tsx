/**
 * The radial menu's look, under its ring in Settings → Overlay → Radial menu and in Settings →
 * Shortcuts & Controls → Radial menu: three boxes side by side, as Overlay appearance's, for its
 * base colour and accent colour (rows of swatches that line up) and its base's opacity. The
 * custom colour pickers report every movement: the ring follows the draft at once, and the
 * setting once the picker rests.
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Slider } from '@kit'
import { RADIAL_BASE_PRESETS, type RadialMenuBase } from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { ColourSwatches } from './ColourSwatches'
import { OpacityScale } from './OverlayLook'
import { useRadialMenuBase, useRadialMenuColor } from './radialMenuPreview'
import './overlay-look.css'
import './radial-menu-section.css'

const MIN_BASE_OPACITY = 10

/** A colour the custom picker drags: shown at once, saved once it rests. */
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

/**
 * The radial menu's look as it is being chosen (`accent`, `base`, for the ring), and the controls
 * that choose it.
 */
export function useRadialStyle(): { accent: string; base: RadialMenuBase; controls: ReactNode } {
  const [, setAccent] = useSetting<string | null>('radialMenuColor', null)
  const savedAccent = useRadialMenuColor()
  const [base, setBase] = useRadialMenuBase()
  const id = useId()
  const [accent, setAccentDraft] = useColourDraft(savedAccent, (value) => void setAccent(value))
  const [baseColor, setBaseDraft] = useColourDraft(base.color, (color) => setBase({ ...base, color }))
  // Saved as the thumb moves (in steps of 5), so the ring follows it live.
  const chooseOpacity = (opacity: number): void => {
    if (opacity !== base.opacity) setBase({ ...base, opacity })
  }

  const controls = (
    // In a container, as Overlay appearance's three, so they sit side by side once there is room.
    <div className="overlay-look">
      <div className="overlay-look-controls radial-style-controls">
        <div className="overlay-look-control">
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
          />
        </div>
        <div className="overlay-look-control">
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
          />
        </div>
        <div className="overlay-look-control">
          <span className="overlay-look-label">Base opacity</span>
          <div className="overlay-look-opacity-control">
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
    </div>
  )
  return { accent, base: { ...base, color: baseColor }, controls }
}
