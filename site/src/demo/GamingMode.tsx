/**
 * Read along in Gaming Mode, ported from the app's ui/controller.js (`showHud`, `render`) with the
 * Halo look of ui/controller-variants.css (`.kd-gm` in demo.css): the hint bar along the bottom of
 * the screen and the outline round the word the controller is on. Sizes are the app's points on a
 * 1280 × 800 handheld screen (`--u`).
 */
import { forwardRef, type ReactNode } from 'react'
import { Icon, ICONS } from './RadialMenu'
import { useResolvedTheme } from './env'
import type { Reading } from './script'

function Hint({ glyph, tone, children }: { glyph: string; tone?: 'confirm' | 'cancel'; children: ReactNode }) {
  return (
    <span className="cm-hint">
      <kbd className={`cm-glyph${tone ? ` cm-${tone}` : ''}`}>{glyph}</kbd>
      {children}
    </span>
  )
}

interface HintBarProps {
  reading: Reading
  /** The lit word's place among the line's words, from 0; null before there is one. */
  index: number | null
  count: number
  leaving: boolean
}

/**
 * The hint bar, as `showHud` draws it for a controller on horizontal text, stepping by word, with
 * the built-in Yomitan pop-up (its buttons can take the focus, so A says "Pop-up") and the default
 * buttons (Settings → Shortcuts & Controls).
 */
export function HintBar({ reading, index, count, leaving }: HintBarProps) {
  const theme = useResolvedTheme()
  const popup = reading.layer === 'popup'
  const message = reading.loading ? 'Reading the text…' : index !== null ? `${index + 1} / ${count}` : ''
  return (
    <div className="kd-gm kd-gm-layer" data-cm-theme={theme} aria-hidden="true">
      <div className={`cm-hud ${leaving ? 'cm-leaving' : ''}`}>
        <span className="cm-hud-mark">
          <Icon paths={ICONS.dictionary} />
        </span>
        <span className="cm-hud-mode" data-mode={popup ? 'popup' : 'word'}>
          {popup ? 'Pop-up' : 'Word'}
        </span>
        <span className="cm-hud-message">{message}</span>
        {popup ? (
          <>
            <Hint glyph="D-pad">Choose</Hint>
            <Hint glyph="A" tone="confirm">
              Press
            </Hint>
            <Hint glyph="X">Audio</Hint>
            <Hint glyph="LB RB">Entry</Hint>
            <Hint glyph="B" tone="cancel">
              Back to text
            </Hint>
          </>
        ) : (
          <>
            <Hint glyph="◀ ▶">Word</Hint>
            <Hint glyph="▲ ▼">Line</Hint>
            <Hint glyph="A" tone="confirm">
              Pop-up
            </Hint>
            <Hint glyph="Y">By character</Hint>
            <Hint glyph="View">Controls</Hint>
            <Hint glyph="B" tone="cancel">
              Back to game
            </Hint>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The outline round the lit word (`.cm-word`), placed by GameScreen over the word's box with the
 * app's 3-point pad; it glides from word to word.
 */
export const WordOutline = forwardRef<HTMLDivElement>(function WordOutline(_props, ref) {
  const theme = useResolvedTheme()
  return (
    <div className="kd-gm kd-gm-layer kd-gm-under" data-cm-theme={theme} aria-hidden="true">
      <div ref={ref} className="cm-word" />
    </div>
  )
})
