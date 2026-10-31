/**
 * Settings → OCR & Overlay → Overlay look: the colour of the highlight over hoverable text, and
 * whether the card a hovered word turns into (and the grouped overlay's regions) is light, dark or
 * the same as Kimochi. Each card choice is previewed with the overlay's own elements and
 * stylesheet (ui/overlay-text.css), in the chosen colour, so what is shown is what is drawn.
 *
 * The stored setting is `overlayStyle` (ui/settings.ts `OverlayStyleSettings`); the overlay reads
 * it live (overlay.js `applyOverlayStyle`).
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { Check, Monitor, Moon, Pipette, Sun } from 'lucide-react'
import { SettingsRow, cn } from '@kit'
import {
  DEFAULT_OVERLAY_STYLE,
  OVERLAY_HIGHLIGHT_PRESETS,
  hexToRgbTriplet,
  overlayStyleOf,
  type OverlayCardAppearance,
  type OverlayStyleSettings
} from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { usePrefs } from '../../kit/appearance-state'
import '@ui/overlay-text.css'
import './overlay-look.css'

const CARD_CHOICES: readonly {
  value: OverlayCardAppearance
  label: string
  detail: string
  icon: ReactNode
}[] = [
  { value: 'app', label: 'Same as Kimochi', detail: 'Follows Appearance in General.', icon: <Monitor /> },
  { value: 'light', label: 'Light', detail: 'White cards, whatever the app uses.', icon: <Sun /> },
  { value: 'dark', label: 'Dark', detail: 'Dark cards, whatever the app uses.', icon: <Moon /> }
]

/** The line the previews read: a word each, the third one hovered. */
const PREVIEW_WORDS = ['今日は', 'いい', '天気', 'ですね']
const PREVIEW_LIT = 2

/**
 * One preview: the overlay's word boxes over a line of game text, as render.js and
 * overlay-text.css draw them. Each word's box fills its own cell, so the box's copy of the text
 * (seen only when lit) sits over the source's; a box at rest shows the highlight, the lit one
 * its card.
 */
function Preview({ theme, colorRgb }: { theme: 'light' | 'dark'; colorRgb: string }): ReactNode {
  return (
    <span
      className="overlay-look-preview"
      data-ocr-theme={theme}
      style={{ '--ocr-hl-rgb': colorRgb } as CSSProperties}
      aria-hidden
    >
      <span className="overlay-look-scene">
        {PREVIEW_WORDS.map((word, index) => (
          <span key={word} className="overlay-look-cell">
            {word}
            <span className="ocr-word" data-lit={index === PREVIEW_LIT ? '' : undefined}>
              <span className="ocr-word-text">
                <span className="ocr-word-current">{word}</span>
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
  // The colour picker reports every movement of the pointer; the previews follow at once, the
  // setting a moment after it rests.
  const [draft, setDraft] = useState<string | null>(null)
  const color = draft ?? look.color
  const colorRgb = hexToRgbTriplet(color) ?? hexToRgbTriplet(DEFAULT_OVERLAY_STYLE.color)!
  const preset = OVERLAY_HIGHLIGHT_PRESETS.some((option) => option.value === color)

  useEffect(() => {
    if (draft === null) return
    const timer = setTimeout(() => {
      setDraft(null)
      if (draft !== look.color) void setStored({ ...look, color: draft })
    }, 250)
    return () => clearTimeout(timer)
  }, [draft, look, setStored])

  const chooseColor = (value: string): void => {
    setDraft(null)
    if (value !== look.color) void setStored({ ...look, color: value })
  }

  return (
    <>
      <SettingsRow
        label="Highlight colour"
        description="The tint and outline over text you can hover."
        stacked
      >
        <div className="overlay-look-swatches">
          <ToggleGroup.Root
            type="single"
            value={preset ? color : ''}
            onValueChange={(value) => value && chooseColor(value)}
            className="overlay-look-presets"
            aria-label="Highlight colour"
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
      </SettingsRow>
      <SettingsRow
        label="Cards"
        description="The card a hovered word turns into, and the grouped overlay's regions."
        stacked
      >
        <ToggleGroup.Root
          type="single"
          value={look.appearance}
          onValueChange={(value) => {
            if (value && value !== look.appearance)
              void setStored({ ...look, appearance: value as OverlayCardAppearance })
          }}
          className="overlay-look-cards"
          aria-label="Cards"
        >
          {CARD_CHOICES.map((choice) => (
            <ToggleGroup.Item key={choice.value} value={choice.value} className="k-choice overlay-look-card">
              <Preview theme={choice.value === 'app' ? resolved : choice.value} colorRgb={colorRgb} />
              <span className="k-choice-head">
                {choice.icon}
                {choice.label}
              </span>
              <span className="k-choice-detail">{choice.detail}</span>
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
      </SettingsRow>
    </>
  )
}
