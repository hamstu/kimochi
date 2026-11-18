/**
 * Settings → Overlay → Overlay appearance: one large live preview, then three controls side by side
 * (one under another in a narrow window): the colour of the highlight over hoverable text, how
 * opaque it is (a slider with its scale; Off hides it), and (a dropdown) the hover card's
 * appearance, the card a hovered word (or the grouped overlay's region) turns into: light, dark,
 * blended, the same as Kimochi, or transparent, no card at all, only the dictionary pop-up (the
 * highlight is separate and stays). The preview is drawn with the overlay's own elements and
 * stylesheet (ui/overlay-text.css) and follows every control as it moves, so what is shown is what
 * is drawn; pointing at a word in it turns that word into its card, with the dictionary pop-up over
 * it at its own opacity (`dictionaryPopupOpacity`, set in `DictionaryOpacityRow` under it, for every engine).
 *
 * The stored setting is `overlayStyle` (ui/settings.ts `OverlayStyleSettings`); the overlay reads
 * it live (overlay.js `applyOverlayStyle`).
 */
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { Check, Pipette } from 'lucide-react'
import { Slider, cn } from '@kit'
import {
  DEFAULT_OVERLAY_STYLE,
  OVERLAY_HIGHLIGHT_PRESETS,
  hexToRgbTriplet,
  highlightStrength,
  overlayStyleOf,
  popupOpacityOf,
  type OverlayStyleSettings,
  type ResolvedCardAppearance
} from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { usePrefs } from '../../kit/appearance-state'
import { PREVIEW_SURFACE, previewWord, usePreviewLine, type PreviewLine } from './overlayPreview'
import { CardLookSelect, TransparentMark } from './CardLook'
import { GridField } from '../../components/GridField'
import '@ui/overlay-text.css'
import './overlay-look.css'

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
  popupOpacity,
  outline = false,
  onPoint
}: {
  theme: ResolvedCardAppearance
  colorRgb: string
  strength: number
  line: PreviewLine
  /** The hovered word, or null for every box at rest. */
  lit?: number | null
  /** The dictionary pop-up over the hovered word is drawn at this opacity (10–100). */
  popupOpacity: number
  /**
   * The looked-up word gets the faint outline the overlay draws over Transparent text
   * (`overlayMatchOutline`, Read along's outline, ui/controller.css `.cm-word-match`).
   */
  outline?: boolean
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
      <GridField />
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
            {index === lit && outline && theme === 'transparent' && <span className="overlay-look-outline" />}
            {index === lit && (
              <span className="overlay-look-popup" style={{ opacity: popupOpacity / 100 }}>
                <span className="overlay-look-popup-term">{previewWord(word, line.shape)}</span>
                <span className="overlay-look-popup-gloss" />
                <span className="overlay-look-popup-gloss" data-short="" />
                <span className="overlay-look-popup-gloss" />
                <span className="overlay-look-popup-gloss" />
                <span className="overlay-look-popup-gloss" data-short="" />
              </span>
            )}
          </span>
        ))}
      </span>
      {theme === 'transparent' && (
        <TransparentMark>
          {/* With the highlight Off as well, nothing at all is drawn over the game. */}
          {strength > 0 ? 'No hover card: only the highlight shows' : 'No hover card or highlight'}
        </TransparentMark>
      )}
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
  const [storedPopupOpacity] = useSetting<number>('dictionaryPopupOpacity', 100)
  const [matchOutline] = useSetting<boolean>('overlayMatchOutline', true)
  const popupOpacity = popupOpacityOf(storedPopupOpacity)

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
  const lit = pointed ?? line.lit

  return (
    <div className="overlay-look">
      <div className="overlay-look-stage">
        <Preview
          theme={cardTheme}
          colorRgb={colorRgb}
          strength={strength}
          line={line}
          lit={lit}
          popupOpacity={popupOpacity}
          outline={matchOutline !== false}
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
              valueText={(value) => (value === 0 ? 'Off' : `${value}%`)}
              value={[opacity]}
              onValueChange={(values) => setOpacityDraft(values[0])}
              min={0}
              max={100}
              step={5}
            />
            <OpacityScale value={opacity} onChoose={setOpacityDraft} />
          </div>
        </div>
        <div className="overlay-look-control">
          <span className="overlay-look-label">Hover card appearance</span>
          <CardLookSelect
            label="Hover card appearance"
            value={look.appearance}
            onChange={(appearance) => void setStored({ ...look, appearance })}
          />
          {look.appearance === 'transparent' && (
            <span className="overlay-look-note">Clicks on scanned text always go through to the game.</span>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Under an opacity slider: its scale from `min` to 100, a tick each 5% and a number each quarter
 * and at `min` (0 is Off). The numbers are buttons that set it there, as a step slider's names are.
 */
export function OpacityScale({
  value,
  min = 0,
  onChoose
}: {
  value: number
  min?: number
  onChoose: (value: number) => void
}): ReactNode {
  const ticks = Array.from({ length: (100 - min) / 5 + 1 }, (_, index) => min + index * 5)
  // Radix keeps the thumb inside the track, so its centre runs from half a thumb in at each end
  // (the thumb is 0.875rem, .k-slider-thumb).
  const at = (step: number): string => `calc(0.4375rem + (100% - 0.875rem) * ${(step - min) / (100 - min)})`
  return (
    <div className="overlay-look-scale">
      <div className="overlay-look-ticks" aria-hidden>
        {ticks.map((step) => (
          <span
            key={step}
            className="overlay-look-tick"
            data-major={step % 25 === 0 || step === min || undefined}
            data-passed={step <= value || undefined}
            style={{ left: at(step) }}
          />
        ))}
      </div>
      <div className="overlay-look-numbers">
        {ticks
          .filter((step) => step % 25 === 0 || step === min)
          .map((step) => (
            <button
              key={step}
              type="button"
              tabIndex={-1}
              className="overlay-look-number"
              data-selected={step === value || undefined}
              style={{ left: at(step) }}
              onClick={() => onChoose(step)}
            >
              {step === 0 ? 'Off' : step}
            </button>
          ))}
      </div>
    </div>
  )
}
