import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { GAME, PLAY_LINES, lookup } from './content'
import { SceneArt } from './SceneArt'
import { WordPopup } from './WordPopup'
import { RadialMenu } from './RadialMenu'
import type { Frame } from './script'

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
 * the dictionary popup, and (Steam Deck) the controller menu.
 */
export function GameScreen({ frame, variant, paused, userCursor, onUserCursor, overlay = true, children }: GameScreenProps) {
  const line = PLAY_LINES[frame.line]
  const user = userCursor !== null && overlay
  const text = user ? 'shown' : frame.text
  const boxes = overlay && (user || frame.boxes)
  const cursor = user ? userCursor : overlay ? frame.cursor : null
  const popup = overlay && (user || frame.popup)
  const [menu, menuLeaving] = useLeaving(user ? null : frame.menu, 200)

  const screenRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const tokenRefs = useRef<(HTMLSpanElement | null)[]>([])

  const token = cursor !== null ? line.tokens[cursor] : null
  const entry = token ? lookup(token.word) : null
  const showPopup = popup && token !== null && entry !== null

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
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') onUserCursor(null)
      }}
    >
      <SceneArt />

      <div
        key={`box-${frame.line}`}
        className={`kd-box ${text === 'typing' ? 'kd-typing' : ''} ${boxes ? 'kd-boxes' : ''}`}
      >
        {line.speaker && (
          <div className="kd-speaker" lang="ja">
            {line.speaker}
          </div>
        )}
        <p className="kd-line" lang="ja" aria-label={line.text}>
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
                className={`kd-word ${known ? 'kd-known' : 'kd-plain'} ${cursor === i ? 'kd-current' : ''}`}
                style={{ ['--w' as string]: w }}
                onPointerEnter={known ? (e) => e.pointerType === 'mouse' && onUserCursor(i) : undefined}
                onClick={known ? () => onUserCursor(userCursor === i ? null : i) : undefined}
              >
                {chars}
              </span>
            )
          })}
        </p>
        {overlay && frame.scan && !user && <div className="kd-shimmer" />}
        <svg className="kd-advance" viewBox="0 0 12 10" aria-hidden="true">
          <path d="M1 1h10L6 9z" fill="currentColor" />
        </svg>
      </div>

      {overlay && frame.scan && !user && <div key={`scan-${frame.line}`} className="kd-sweep" />}

      {menu && <RadialMenu selected={menu.sel} chosen={menu.chosen} leaving={menuLeaving} />}

      {showPopup && token && entry && (
        <WordPopup
          key={`${frame.line}-${cursor}`}
          ref={popupRef}
          word={token.word!}
          entry={entry}
          surface={token.text}
        />
      )}
      {children}
    </div>
  )
}
