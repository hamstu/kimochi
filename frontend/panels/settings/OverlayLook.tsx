/**
 * Settings → Overlay → Overlay appearance: one large live preview, then three controls side by side
 * (one under another in a narrow window): the colour of the highlight over hoverable text, how
 * opaque it is (a slider), and (a dropdown) whether the card a hovered word turns into (and the grouped overlay's regions)
 * is light, dark, blended or the same as Kimochi. The preview is drawn with the overlay's own
 * elements and stylesheet (ui/overlay-text.css) and follows every control as it moves, so what is
 * shown is what is drawn; pointing at a word in it turns that word into its card.
 *
 * The stored setting is `overlayStyle` (ui/settings.ts `OverlayStyleSettings`); the overlay reads
 * it live (overlay.js `applyOverlayStyle`).
 */
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { Blend, Check, Monitor, Moon, Pipette, Sun } from 'lucide-react'
import { Select, Slider, cn } from '@kit'
import {
  DEFAULT_OVERLAY_STYLE,
  OVERLAY_HIGHLIGHT_PRESETS,
  hexToRgbTriplet,
  highlightStrength,
  overlayStyleOf,
  type OverlayCardAppearance,
  type OverlayStyleSettings
} from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { usePrefs } from '../../kit/appearance-state'
import { PREVIEW_SURFACE, previewWord, usePreviewLine, type PreviewLine } from './overlayPreview'
import '@ui/overlay-text.css'
import './overlay-look.css'

const CARD_CHOICES: readonly {
  value: OverlayCardAppearance
  label: string
  icon: ReactNode
}[] = [
  { value: 'app', label: 'Same as Kimochi', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
  { value: 'blend', label: 'Blend', icon: <Blend /> }
]

/**
 * One preview: the overlay's word boxes over a line of game text, as render.js and
 * overlay-text.css draw them. Each word's box fills its own cell, so the box's copy of the text
 * (seen only when lit) sits over the source's; a box at rest shows the highlight, the lit one
 * its card.
 */
function Preview({
  theme,
  colorRgb,
  strength,
  line,
  lit = line.lit,
  onPoint
}: {
  theme: 'light' | 'dark' | 'blend'
  colorRgb: string
  strength: number
  line: PreviewLine
  /** The hovered word, or null for every box at rest. */
  lit?: number | null
  /** The pointer came onto a word (its index), or left the line (null). */
  onPoint?: (index: number | null) => void
}): ReactNode {
  return (
    <span
      className="overlay-look-preview"
      data-ocr-theme={theme}
      style={{ '--ocr-hl-rgb': colorRgb, '--ocr-hl-strength': strength } as CSSProperties}
      aria-hidden
    >
      <span
        className="overlay-look-scene"
        lang={line.lang}
        data-shape={line.shape}
        onPointerLeave={onPoint && (() => onPoint(null))}
      >
        {line.words.map((word, index) => (
          <span key={index} className="overlay-look-cell" onPointerEnter={onPoint && (() => onPoint(index))}>
            {previewWord(word, line.shape)}
            <span
              className="ocr-word"
              data-lit={index === lit ? '' : undefined}
              data-surface={PREVIEW_SURFACE.ink}
              style={
                {
                  '--ocr-surface-top': PREVIEW_SURFACE.top,
                  '--ocr-surface-bottom': PREVIEW_SURFACE.bottom
                } as CSSProperties
              }
            >
              <span className="ocr-word-text">
                <span className="ocr-word-current">{previewWord(word, line.shape)}</span>
              </span>
            </span>
          </span>
        ))}
      </span>
    </span>
  )
}

export function OverlayLook(): ReactNode {
  const [stored, setStored] = useSetting<OverlayStyleSettings>('overlayStyle', DEFAULT_OVERLAY_STYLE)
  const look = useMemo(() => overlayStyleOf(stored), [stored])
  const { resolved } = usePrefs()
  const line = usePreviewLine()
  // The colour picker reports every movement of the pointer; the previews follow at once, the
  // setting a moment after it rests.
  const [draft, setDraft] = useState<string | null>(null)
  const color = draft ?? look.color
  const colorRgb = hexToRgbTriplet(color) ?? hexToRgbTriplet(DEFAULT_OVERLAY_STYLE.color)!
  const preset = OVERLAY_HIGHLIGHT_PRESETS.some((option) => option.value === color)
  // The slider likewise: the preview follows the thumb, the setting follows when it rests.
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null)
  const opacity = opacityDraft ?? look.opacity
  const strength = highlightStrength(opacity)

  useEffect(() => {
    if (draft === null) return
    const timer = setTimeout(() => {
      setDraft(null)
      if (draft !== look.color) void setStored({ ...look, color: draft })
    }, 250)
    return () => clearTimeout(timer)
  }, [draft, look, setStored])

  useEffect(() => {
    if (opacityDraft === null) return
    const timer = setTimeout(() => {
      setOpacityDraft(null)
      if (opacityDraft !== look.opacity) void setStored({ ...look, opacity: opacityDraft })
    }, 250)
    return () => clearTimeout(timer)
  }, [opacityDraft, look, setStored])

  // The preview's word under the pointer, which shows as its card; at rest, the sample's own.
  const [pointed, setPointed] = useState<number | null>(null)
  const id = useId()

  const chooseColor = (value: string): void => {
    setDraft(null)
    if (value !== look.color) void setStored({ ...look, color: value })
  }

  const cardTheme = look.appearance === 'app' ? resolved : look.appearance

  return (
    <div className="overlay-look">
      <div className="overlay-look-stage">
        <Preview
          theme={cardTheme}
          colorRgb={colorRgb}
          strength={strength}
          line={line}
          lit={pointed ?? line.lit}
          onPoint={setPointed}
        />
      </div>
      <div className="overlay-look-controls">
        <div className="overlay-look-control">
          <span className="overlay-look-label" id={`${id}-colour`}>
            Highlight colour
          </span>
          <div className="overlay-look-swatches">
            <ToggleGroup.Root
              type="single"
              value={preset ? color : ''}
              onValueChange={(value) => value && chooseColor(value)}
              className="overlay-look-presets"
              aria-labelledby={`${id}-colour`}
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
              style={{ '--swatch': color } as CSSProperties}
              title="Custom colour"
            >
              <input
                type="color"
                value={color}
                aria-label="Custom highlight colour"
                onChange={(event) => setDraft(event.target.value.toLowerCase())}
              />
              {preset ? <Pipette aria-hidden /> : <Check aria-hidden />}
            </label>
          </div>
        </div>
        <div className="overlay-look-control">
          <span className="overlay-look-label">Highlight opacity</span>
          <div className="overlay-look-opacity-control">
            <Slider
              aria-label="Highlight opacity"
              valueText={(value) => `${value}%`}
              value={[opacity]}
              onValueChange={(values) => setOpacityDraft(values[0])}
              min={0}
              max={100}
              step={5}
            />
          </div>
        </div>
        <div className="overlay-look-control">
          <span className="overlay-look-label">Cards</span>
          <Select
            aria-label="Cards"
            className="overlay-look-card-select"
            value={look.appearance}
            onValueChange={(value) => {
              if (value !== look.appearance) void setStored({ ...look, appearance: value })
            }}
            options={CARD_CHOICES.map((choice) => ({
              value: choice.value,
              label: (
                <span className="overlay-look-card-option">
                  {choice.icon}
                  {choice.label}
                </span>
              )
            }))}
          />
        </div>
      </div>
    </div>
  )
}
