/**
 * A colour picked from Kimochi's highlight colours (`OVERLAY_HIGHLIGHT_PRESETS`) or any colour
 * (the pipette swatch, the system colour picker): Settings → Overlay → Overlay appearance's
 * Highlight colour, and the Radial menu's colour. The picker reports every movement, which
 * `onDraft` gets so a preview can follow at once; the caller saves once it rests.
 */
import type { CSSProperties, ReactNode } from 'react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { Check, Pipette } from 'lucide-react'
import { cn } from '@kit'
import { OVERLAY_HIGHLIGHT_PRESETS } from '@ui/settings'

export function ColourSwatches({
  value,
  label,
  labelledBy,
  onChoose,
  onDraft
}: {
  /** The colour shown as chosen, `#rrggbb`. */
  value: string
  /** What the colour is for, for the custom swatch's name ("Custom highlight colour"). */
  label: string
  /** The id of the visible label naming the swatches. */
  labelledBy?: string
  /** A swatch was picked. */
  onChoose: (value: string) => void
  /** The custom picker moved. */
  onDraft: (value: string) => void
}): ReactNode {
  const preset = OVERLAY_HIGHLIGHT_PRESETS.some((option) => option.value === value)
  return (
    <div className="overlay-look-swatches">
      <ToggleGroup.Root
        type="single"
        value={preset ? value : ''}
        onValueChange={(next) => next && onChoose(next)}
        className="overlay-look-presets"
        aria-labelledby={labelledBy}
      >
        {OVERLAY_HIGHLIGHT_PRESETS.map((option) => (
          <ToggleGroup.Item
            key={option.value}
            value={option.value}
            className="overlay-look-swatch"
            style={{ '--swatch': option.value } as CSSProperties}
            aria-label={option.label}
            title={option.label}
          >
            <Check aria-hidden />
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
      <label
        className={cn('overlay-look-swatch', 'overlay-look-swatch-custom')}
        data-state={preset ? 'off' : 'on'}
        style={{ '--swatch': value } as CSSProperties}
        title="Custom colour"
      >
        <input
          type="color"
          value={value}
          aria-label={`Custom ${label}`}
          onChange={(event) => onDraft(event.target.value.toLowerCase())}
        />
        {preset ? <Pipette aria-hidden /> : <Check aria-hidden />}
      </label>
    </div>
  )
}
