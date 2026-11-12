/**
 * Settings → OCR & Overlay → Overlay look: the colour of the highlight over hoverable text and
 * how opaque it is (side by side, or one under the other in a narrow window), and whether the card a hovered word turns into (and the grouped overlay's regions) is light, dark or
 * the same as Kimochi. Each card choice is previewed with the overlay's own elements and
 * stylesheet (ui/overlay-text.css), in the chosen colour, so what is shown is what is drawn.
 *
 * The stored setting is `overlayStyle` (ui/settings.ts `OverlayStyleSettings`); the overlay reads
 * it live (overlay.js `applyOverlayStyle`).
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { Blend, Check, Monitor, Moon, Pipette, Sun } from 'lucide-react'
import { SettingsRow, Slider, cn } from '@kit'
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
import { useLanguage } from '../../bridge/useLanguage'
import { usePrefs } from '../../kit/appearance-state'
import { sampleFor } from '@ui/language-samples'
import { textLang } from '@ui/language-style'
import { GlyphBlocks } from '../../components/GlyphBlocks'
import { blockShape, blockWords } from '../../components/glyphBlockShapes'
import '@ui/overlay-text.css'
import './overlay-look.css'

const CARD_CHOICES: readonly {
  value: OverlayCardAppearance
  label: string
  detail: string
  icon: ReactNode
}[] = [
  { value: 'app', label: 'Same as Kimochi', detail: 'Follows Appearance in General.', icon: <Monitor /> },
  { value: 'light', label: 'Light', detail: 'White cards.', icon: <Sun /> },
  { value: 'dark', label: 'Dark', detail: 'Dark cards.', icon: <Moon /> },
  {
    value: 'blend',
    label: 'Blend',
    detail: 'The colours behind each word, as if the game drew it.',
    icon: <Blend />
  }
]

/** Blend's preview: what the preview's dialogue box is, behind its words. */
const PREVIEW_SURFACE = { top: '#1b2033', bottom: '#151a2a', ink: 'light' } as const

/**
 * The line the previews read, a word each with one hovered, in the language being read: its sample
 * (ui/language-samples.ts; Japanese's is 今日は いい 天気 ですね, 天気 hovered), or, for a language
 * with none, glyph blocks shaped like its words.
 */
interface PreviewLine {
  /** Each word's text, or its length in blocks. */
  words: readonly (string | number)[]
  lit: number
  /** Set for a language other than Japanese only: the Japanese preview is as it always was. */
  lang: string | undefined
  shape: 'square' | 'word'
}

function usePreviewLine(): PreviewLine {
  const [language] = useLanguage()
  return useMemo(() => {
    const sample = sampleFor(language.code)
    const shape = blockShape(language.code)
    const lang = language.code === 'ja' ? undefined : textLang(language.code)
    return sample
      ? { words: sample.preview, lit: sample.lit, lang, shape }
      : { words: blockWords(language.code), lit: 1, lang, shape }
  }, [language.code])
}

/** A preview word: its text, or blocks in its shape. */
const previewWord = (word: string | number, shape: PreviewLine['shape']): ReactNode =>
  typeof word === 'string' ? word : <GlyphBlocks length={word} shape={shape} />

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
  lit = line.lit
}: {
  theme: 'light' | 'dark' | 'blend'
  colorRgb: string
  strength: number
  line: PreviewLine
  /** The hovered word, or null for every box at rest. */
  lit?: number | null
}): ReactNode {
  return (
    <span
      className="overlay-look-preview"
      data-ocr-theme={theme}
      style={{ '--ocr-hl-rgb': colorRgb, '--ocr-hl-strength': strength } as CSSProperties}
      aria-hidden
    >
      <span className="overlay-look-scene" lang={line.lang} data-shape={line.shape}>
        {line.words.map((word, index) => (
          <span key={index} className="overlay-look-cell">
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

  const chooseColor = (value: string): void => {
    setDraft(null)
    if (value !== look.color) void setStored({ ...look, color: value })
  }

  return (
    <>
      <div className="overlay-look-highlight">
        <div className="overlay-look-highlight-grid">
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
            label="Highlight opacity"
            description="How strongly it shows before you point at it."
            stacked
          >
            <div className="overlay-look-opacity">
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
                <span className="overlay-look-opacity-value" aria-hidden>
                  {opacity}%
                </span>
              </div>
              <Preview theme={resolved} colorRgb={colorRgb} strength={strength} line={line} lit={null} />
            </div>
          </SettingsRow>
        </div>
      </div>
      <SettingsRow
        label="Cards"
        description="The card hovered text turns into."
        stacked
      >
        <div className="overlay-look-cards-frame">
          <ToggleGroup.Root
            type="single"
            value={look.appearance}
            onValueChange={(value) => {
              if (value && value !== look.appearance)
                void setStored({ ...look, appearance: value as OverlayCardAppearance })
            }}
            className="overlay-look-cards"
            data-count={CARD_CHOICES.length}
            aria-label="Cards"
          >
            {CARD_CHOICES.map((choice) => (
              <ToggleGroup.Item key={choice.value} value={choice.value} className="k-choice overlay-look-card">
                <Preview
                  theme={choice.value === 'app' ? resolved : choice.value}
                  colorRgb={colorRgb}
                  strength={strength}
                  line={line}
                />
                <span className="k-choice-head">
                  {choice.icon}
                  {choice.label}
                </span>
                <span className="k-choice-detail">{choice.detail}</span>
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
        </div>
      </SettingsRow>
    </>
  )
}
