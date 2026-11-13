import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { GAME, PLAY_LINES, lookup } from './content'
import { SceneArt } from './SceneArt'
import { WordPopup, type AnkiState } from './WordPopup'
import { RadialMenu } from './RadialMenu'
import { HintBar, WordOutline } from './GamingMode'
import { wordStops, type Frame } from './script'

interface GameScreenProps {
  frame: Frame
  variant: 'desktop' | 'deck'
  /** Freeze CSS animations (offscreen, tab hidden). */
  paused: boolean
  /** The visitor's own pick (hover / tap), which overrides the script. */
  userCursor: number | null
  onUserCursor: (index: number | null) => void
  /** Kimochi's overlay is on (Show overlay): without it, no scan sweep, word boxes or pop-ups. */
  overlay?: boolean
  /** The Text Hooker: Kimochi's card over the game's text instead of word boxes, and no scan. */
  hook?: boolean
  /**
   * The Text Hooker's card is over the game's text (Auto align). Off, the card sits elsewhere on
   * the game, and glides over the text when it comes on.
   */
  aligned?: boolean
  /** Add to Anki per word, when the pop-up's + works (the guided desk). */
  anki?: Record<string, AnkiState>
  onAnki?: (word: string) => void
  /** The pop-up stays open when the pointer leaves the game (until another word, or a click). */
  sticky?: boolean
  /** A click on the game: on to its next line, as in a visual novel. */
  onAdvance?: () => void
  children?: ReactNode
}

/** Keeps the last open menu on screen for its exit animation. */
function useLeaving<T>(value: T | null, ms: number): [T | null, boolean] {
  const [last, setLast] = useState<T | null>(value)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (value !== null) {
      setLast(value)
      setLeaving(false)
      return
    }
    setLeaving(true)
    const t = setTimeout(() => {
      setLast(null)
      setLeaving(false)
    }, ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return [value ?? last, leaving && value === null]
}

/**
 * The synthetic visual novel with Kimochi's overlay on top: dialogue box, scan sweep, word boxes,
 * the dictionary popup, and (handheld) Gaming Mode: the controller menu, and Read along's outline
 * and hint bar.
 */
export function GameScreen({
  frame,
  variant,
  paused,
  userCursor,
  onUserCursor,
  overlay = true,
  hook = false,
  aligned = true,
  anki,
  onAnki,
  onAdvance,
  sticky = false,
  children
}: GameScreenProps) {
  const line = PLAY_LINES[frame.line]
  const deck = variant === 'deck'
  const user = userCursor !== null && overlay
  const text = user ? 'shown' : frame.text
  const cursor = user ? userCursor : overlay ? frame.cursor : null
  const popup = overlay && (user || frame.popup)
  const [menu, menuLeaving] = useLeaving(user ? null : frame.menu, 200)
  // Handheld: a visitor's tap reads along from that word, as the controller would.
  const reading = deck && overlay ? (user ? { layer: 'text' as const } : frame.reading) : null
  // Read along quiets the overlay's word boxes (the app's `quietText`): the outline marks the word.
  const boxes = overlay && !reading && (user || frame.boxes)
  const outlined = reading !== null && !reading.loading && cursor !== null

  // The hooked line's card away from the text (Auto align off), then gliding over it once it is on:
  // a copy of the card, drawn where the line is, moved up until it settles.
  const [settled, setSettled] = useState(aligned)
  useEffect(() => {
    if (!aligned) return setSettled(false)
    const t = setTimeout(() => setSettled(true), 650)
    return () => clearTimeout(t)
  }, [aligned])
  const floating = hook && boxes && !settled
  const lineRef = useRef<HTMLParagraphElement>(null)
  const [lineBox, setLineBox] = useState<{ left: number; top: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const screen = screenRef.current
    const el = lineRef.current
    if (!floating || !screen || !el) return
    const place = (): void => {
      const s = screen.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      const scale = s.width / screen.offsetWidth || 1
      setLineBox({ left: (r.left - s.left) / scale, top: (r.top - s.top) / scale, width: r.width / scale })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(screen)
    return () => observer.disconnect()
  }, [floating, frame.line])

  const stops = useMemo(() => wordStops(frame.line), [frame.line])
  const at = cursor !== null && stops.includes(cursor) ? stops.indexOf(cursor) : null
  const layer = reading?.layer ?? null
  const loading = reading?.loading ?? false
  const hudNow = useMemo(
    () => (layer ? { layer, loading, index: at, count: stops.length } : null),
    [layer, loading, at, stops.length]
  )
  const [hud, hudLeaving] = useLeaving(hudNow, 200)

  // On the desktop a mouse looks a word up as the app does: over it with Shift held (pressed while
  // over it, or held on the way in). A touch has no Shift: a tap does it. The handheld taps too.
  const needShift = !deck
  const hovered = useRef<number | null>(null)
  const pick = useRef(onUserCursor)
  pick.current = onUserCursor
  useEffect(() => {
    if (!needShift) return
    const down = (event: KeyboardEvent): void => {
      if (event.key === 'Shift' && !event.repeat && hovered.current !== null) pick.current(hovered.current)
    }
    addEventListener('keydown', down)
    return () => removeEventListener('keydown', down)
  }, [needShift])

  const screenRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef<HTMLDivElement>(null)
  const tokenRefs = useRef<(HTMLSpanElement | null)[]>([])

  const token = cursor !== null ? line.tokens[cursor] : null
  const entry = token ? lookup(token.word) : null
  const showPopup = popup && token !== null && entry !== null && !reading?.loading

  // Place the popup above the word, inside the screen; re-place on resize.
  useLayoutEffect(() => {
    const screen = screenRef.current
    const el = popupRef.current
    const anchor = cursor !== null ? tokenRefs.current[cursor] : null
    if (!screen || !el || !anchor || !showPopup) return
    const place = (): void => {
      const s = screen.getBoundingClientRect()
      const a = anchor.getBoundingClientRect()
      const scale = s.width / screen.offsetWidth || 1
      const w = el.offsetWidth * scale
      const h = el.offsetHeight * scale
      const gap = 10
      const centre = a.left + a.width / 2 - s.left
      const left = Math.min(Math.max(6, centre - w / 2), s.width - w - 6)
      // Above the word; below when it does not fit; else as high as the screen allows.
      let top = a.top - s.top - h - gap
      let origin = '100%'
      if (top < 6) {
        const below = a.bottom - s.top + gap
        if (below + h <= s.height - 6) {
          top = below
          origin = '0%'
        } else top = 6
      }
      el.style.left = `${left / scale}px`
      el.style.top = `${top / scale}px`
      el.style.setProperty('--origin', `${((centre - left) / w) * 100}% ${origin}`)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(screen)
    return () => observer.disconnect()
  }, [cursor, showPopup, frame.line])

  // The outline round the lit word (the app's `render`): the word's box, padded 3 points.
  useLayoutEffect(() => {
    const screen = screenRef.current
    const el = outlineRef.current
    const anchor = cursor !== null ? tokenRefs.current[cursor] : null
    if (!screen || !el || !anchor || !outlined) return
    const place = (): void => {
      const s = screen.getBoundingClientRect()
      const a = anchor.getBoundingClientRect()
      const scale = s.width / screen.offsetWidth || 1
      const pad = (3 * screen.offsetWidth) / 1280
      el.style.left = `${(a.left - s.left) / scale - pad}px`
      el.style.top = `${(a.top - s.top) / scale - pad}px`
      el.style.width = `${a.width / scale + pad * 2}px`
      el.style.height = `${a.height / scale + pad * 2}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(screen)
    return () => observer.disconnect()
  }, [cursor, outlined, frame.line])

  // How near each word's box is to the word being looked up (--p), as render.js sets --ocr-near: 1
  // at that word, fading to 0 a third of the screen's width away (the app's 300 px on a game
  // window). With no word looked up, every box rests at its faintest.
  useLayoutEffect(() => {
    const screen = screenRef.current
    if (!screen) return
    const anchor = cursor !== null ? tokenRefs.current[cursor] : null
    const centre = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    const reach = screen.getBoundingClientRect().width / 3
    const a = anchor ? centre(anchor) : null
    for (const el of tokenRefs.current) {
      if (!el) continue
      let p = 0
      if (a) {
        const b = centre(el)
        p = Math.max(0, 1 - Math.hypot(b.x - a.x, b.y - a.y) / reach)
      }
      el.style.setProperty('--p', p.toFixed(2))
    }
  }, [cursor, frame.line, boxes])

  let charIndex = 0
  let wordIndex = 0
  const style = {
    '--kd-sky-0': GAME.scene.sky[0],
    '--kd-glow': GAME.scene.glow
  } as CSSProperties

  return (
    <div
      ref={screenRef}
      className={`kd-screen ${variant === 'deck' ? 'kd-deck' : ''} ${paused ? 'kd-paused' : ''}`}
      style={style}
      onClick={onAdvance}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse' && !sticky) onUserCursor(null)
      }}
    >
      <SceneArt />

      <div
        key={`box-${frame.line}`}
        className={`kd-box ${text === 'typing' ? 'kd-typing' : ''} ${boxes ? (hook ? (floating ? '' : 'kd-hooked') : 'kd-boxes') : ''}`}
      >
        {line.speaker && (
          <div className="kd-speaker" lang="ja">
            {line.speaker}
          </div>
        )}
        <p ref={lineRef} className="kd-line" lang="ja" aria-label={line.text}>
          {line.tokens.map((t, i) => {
            const chars = Array.from(t.text).map((c) => (
              <span key={charIndex} className="kd-char" style={{ ['--c' as string]: charIndex++ }}>
                {c}
              </span>
            ))
            if (t.punct) return <span key={i}>{chars}</span>
            const known = t.word !== null
            const w = wordIndex++
            return (
              <span
                key={i}
                ref={(el) => {
                  tokenRefs.current[i] = el
                }}
                data-token={i}
                className={`kd-word ${known ? 'kd-known' : 'kd-plain'} ${cursor === i && !reading ? 'kd-current' : ''} ${showPopup && cursor === i && !reading ? 'kd-selected' : ''}`}
                style={{ ['--w' as string]: w }}
                onPointerEnter={
                  known
                    ? (e) => {
                        if (e.pointerType !== 'mouse') return
                        hovered.current = i
                        if (!needShift || e.shiftKey) onUserCursor(i)
                      }
                    : undefined
                }
                onPointerMove={
                  known && needShift
                    ? (e) => e.pointerType === 'mouse' && e.shiftKey && userCursor !== i && onUserCursor(i)
                    : undefined
                }
                onPointerLeave={
                  known ? () => (hovered.current = hovered.current === i ? null : hovered.current) : undefined
                }
                onPointerUp={
                  known && needShift
                    ? (e) => e.pointerType !== 'mouse' && onUserCursor(userCursor === i ? null : i)
                    : undefined
                }
                onClick={known && !needShift ? () => onUserCursor(userCursor === i ? null : i) : undefined}
              >
                {chars}
              </span>
            )
          })}
        </p>
        {overlay && frame.scan && !user && !hook && <div className="kd-shimmer" />}
        <svg className="kd-advance" viewBox="0 0 12 10" aria-hidden="true">
          <path d="M1 1h10L6 9z" fill="currentColor" />
        </svg>
      </div>

      {overlay && frame.scan && !user && !hook && <div key={`scan-${frame.line}`} className="kd-sweep" />}

      {floating && lineBox && (
        <div
          aria-hidden="true"
          className={`kd-hooked kd-hookcard ${aligned ? 'kd-hookcard-in' : ''}`}
          style={{ left: lineBox.left, top: lineBox.top, width: lineBox.width }}
        >
          <p className="kd-line" lang="ja">
            {line.text}
          </p>
        </div>
      )}

      {outlined && <WordOutline ref={outlineRef} />}

      {showPopup && token && entry && (
        <WordPopup
          key={`${frame.line}-${cursor}`}
          ref={popupRef}
          word={token.word!}
          entry={entry}
          surface={token.text}
          focused={reading?.layer === 'popup'}
          anki={anki?.[token.word!]}
          onAnki={onAnki ? () => onAnki(token.word!) : undefined}
        />
      )}

      {hud && (
        <HintBar
          reading={{ layer: hud.layer, loading: hud.loading }}
          index={hud.index}
          count={hud.count}
          leaving={hudLeaving}
        />
      )}

      {menu && <RadialMenu selected={menu.sel} chosen={menu.chosen} leaving={menuLeaving} hasText={frame.line > 0} />}
      {children}
    </div>
  )
}
