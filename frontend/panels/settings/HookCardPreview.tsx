/**
 * The Text Hooker's card over a little game, for Settings (Overlay → Text Hooker card, and Text
 * Hooker → Card style for the defaults and each game): the overlay's own card (ui/hook-card.css) in
 * the Cards look (Settings → Overlay appearance), over a scene with the game's dialogue box and its
 * own line. With Auto align the card sits on the game's line and covers it, as it does over a game;
 * without, it sits where it was dragged and the game's line shows below. Text size is a share of
 * the game's height and the opacity fades the card's background, as on the overlay.
 *
 * Given `actions` (Text Hooker → Card style), it works as the real card does: with the lookup key
 * held (or click-through off), its top bar drags it and its corner resizes it, either of which
 * turns Auto align off; −/+ step the text
 * size, which turns Auto align off too; and ⋯ opens the opacity menu. Each changes the setting
 * shown under it. Where it was dragged to, and its size, stay in the preview (it is not a game's
 * window).
 */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { AArrowDown, AArrowUp, Ellipsis } from 'lucide-react'
import { Kbd } from '@kit'
import { DEFAULT_OVERLAY_STYLE, overlayStyleOf, type OverlayStyleSettings } from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { useLanguage } from '../../bridge/useLanguage'
import { useCapabilities } from '../../bridge/capabilities'
import { usePrefs } from '../../kit/appearance-state'
import { lookupKeyName, PREVIEW_SURFACE, previewWord, usePreviewLine } from './overlayPreview'
import '@ui/overlay-text.css'
import '@ui/hook-card.css'
import './overlay-look.css'

/**
 * The game window the preview stands for, in pixels tall: Small to Larger read as they would over
 * a game this size.
 */
const PREVIEW_GAME_HEIGHT = 600
/** The text sizes −/+ step through: Text size's choices (Settings → Text Hooker). */
const HOOK_TEXT_SIZES = [0.026, 0.034, 0.042, 0.05]
/** The opacities ⋯ offers, as on the real card (ui/hook-card.js `HOOK_CARD_OPACITIES`). */
const OPACITIES = [1, 0.85, 0.7, 0.55, 0.4]
/** The smallest the corner makes the box, as on the real card (ui/hook-card.js), with its padding. */
const MIN_WIDTH = 60 + 28
const MIN_HEIGHT = 16 + 42
/** Room the ⋯ menu needs above the card; nearer the top it opens below it instead. */
const MENU_ROOM_PX = 110

/** The modifier property a pointer event carries for a lookup key (`overlayLookupKey`). */
const KEY_PROPERTY = { shift: 'shiftKey', ctrl: 'ctrlKey', alt: 'altKey', meta: 'metaKey' } as const
/** The `KeyboardEvent.key` of a lookup key. */
const KEY_NAME = { shift: 'Shift', ctrl: 'Control', alt: 'Alt', meta: 'Meta' } as const
type LookupKey = keyof typeof KEY_PROPERTY

export interface HookCardActions {
  /** The card was dragged: Auto align off. */
  onMoved: () => void
  /** −/+: the next text size, with Auto align off. */
  onTextSize: (textSize: number) => void
  onOpacity: (opacity: number) => void
}

/** The next of `HOOK_TEXT_SIZES` from `size`, one step `step` (−1 or +1) along. */
function stepTextSize(size: number, step: number): number {
  let nearest = 0
  HOOK_TEXT_SIZES.forEach((value, index) => {
    if (Math.abs(value - size) < Math.abs(HOOK_TEXT_SIZES[nearest] - size)) nearest = index
  })
  return HOOK_TEXT_SIZES[Math.min(HOOK_TEXT_SIZES.length - 1, Math.max(0, nearest + step))]
}

/** Whether the lookup key is down, from the keyboard and from each pointer event's modifiers. */
function useKeyHeld(key: LookupKey): [boolean, (event: PointerEvent) => void] {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key === KEY_NAME[key]) setHeld(true)
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === KEY_NAME[key]) setHeld(false)
    }
    const away = (): void => setHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', away)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', away)
    }
  }, [key])
  return [held, (event) => setHeld(Boolean(event[KEY_PROPERTY[key]]))]
}

export function HookCardPreview({
  autoAlign,
  textSize,
  opacity,
  actions
}: {
  autoAlign: boolean
  /** A share of the game window's height (`HookSettings.textSize`). */
  textSize: number
  /** The card's background, 0–1 (`HookSettings.opacity`). */
  opacity: number
  /** Works like the real card, changing these settings (Text Hooker → Card style). */
  actions?: HookCardActions
}): ReactNode {
  const [stored] = useSetting<OverlayStyleSettings>('overlayStyle', DEFAULT_OVERLAY_STYLE)
  const [storedKey] = useSetting<string>('overlayLookupKey', 'shift')
  const [clickThrough] = useSetting<boolean>('overlayClickThrough', true)
  const { os } = useCapabilities()
  const { resolved } = usePrefs()
  const [language] = useLanguage()
  const line = usePreviewLine()
  const key: LookupKey = storedKey && storedKey in KEY_PROPERTY ? (storedKey as LookupKey) : 'shift'
  const [held, track] = useKeyHeld(key)
  // As over a game: with click-through, the card takes the mouse only while the key is held.
  const armed = Boolean(actions) && (clickThrough === false || held)
  const scene = useRef<HTMLSpanElement>(null)
  const card = useRef<HTMLSpanElement>(null)
  // Where the card was dragged to (its top-left in the scene), or null for its usual place. With
  // Auto align on it sits on the game's line instead, and comes back here when it is turned off,
  // as the real card does.
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null)
  // Its size from the corner: the box is at least this big and grows to fit its line, as the
  // real card's is (its text keeps its size).
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{
    kind: 'move' | 'resize'
    id: number
    /** Where the pointer and the card were when the drag began, in the scene. */
    px: number
    py: number
    x: number
    y: number
    width: number
    height: number
    moved: boolean
  } | null>(null)
  const [menu, setMenu] = useState<null | 'above' | 'below'>(null)

  // The key let go with the menu open: it stays, as on the overlay, until a choice or a click away.
  useEffect(() => {
    if (!menu) return
    const away = (event: globalThis.PointerEvent): void => {
      if (!card.current?.contains(event.target as Node)) setMenu(null)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [menu])

  const look = overlayStyleOf(stored)
  const theme = look.appearance === 'app' ? resolved : look.appearance
  const fontPx = Math.round(textSize * PREVIEW_GAME_HEIGHT)
  const gap = language.spaces ? ' ' : ''
  const text = line.words.map((word, index) => (
    <span key={index}>
      {index > 0 && gap}
      {previewWord(word, line.shape)}
    </span>
  ))

  const startDrag =
    (kind: 'move' | 'resize') =>
    (event: PointerEvent<HTMLSpanElement>): void => {
      if (!armed || !card.current || !scene.current) return
      event.preventDefault()
      event.stopPropagation()
      const area = scene.current.getBoundingClientRect()
      const box = card.current.getBoundingClientRect()
      drag.current = {
        kind,
        id: event.pointerId,
        px: event.clientX - area.left,
        py: event.clientY - area.top,
        x: box.left - area.left,
        y: box.top - area.top,
        width: box.width,
        height: box.height,
        moved: false
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // The pointer is already gone: the drag follows it while it stays over the bar or corner.
      }
      setMenu(null)
    }
  const moveDrag = (event: PointerEvent<HTMLSpanElement>): void => {
    const now = drag.current
    if (!now || now.id !== event.pointerId || !scene.current) return
    const area = scene.current.getBoundingClientRect()
    const dx = event.clientX - area.left - now.px
    const dy = event.clientY - area.top - now.py
    if (!now.moved) {
      now.moved = true
      setDragging(true)
      // Placing it by hand is the reader taking over, as on the overlay.
      if (autoAlign) actions?.onMoved()
    }
    if (now.kind === 'move') {
      const width = card.current?.offsetWidth ?? now.width
      const height = card.current?.offsetHeight ?? now.height
      setPlace({
        x: Math.min(Math.max(0, now.x + dx), Math.max(0, area.width - width)),
        y: Math.min(Math.max(0, now.y + dy), Math.max(0, area.height - height))
      })
    } else {
      // The top-left stays put; the box keeps within the scene.
      setPlace({ x: now.x, y: now.y })
      setSize({
        width: Math.min(Math.max(MIN_WIDTH, now.width + dx), area.width - now.x),
        height: Math.min(Math.max(MIN_HEIGHT, now.height + dy), area.height - now.y)
      })
    }
  }
  const endDrag = (event: PointerEvent<HTMLSpanElement>): void => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }
  const dragHandlers = (kind: 'move' | 'resize') =>
    actions
      ? { onPointerDown: startDrag(kind), onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag }
      : {}
  const toggleMenu = (): void => {
    if (!armed && !menu) return
    if (menu) return setMenu(null)
    const top = card.current && scene.current ? card.current.offsetTop : MENU_ROOM_PX
    setMenu(top < MENU_ROOM_PX ? 'below' : 'above')
  }

  // While a drag turns Auto align off, the card follows the pointer from the first move.
  const placed = (!autoAlign || dragging) && place
  return (
    <div className="hook-preview-stage">
      <span
        ref={scene}
        className="overlay-look-preview hook-preview-scene"
        data-aligned={autoAlign && !dragging ? '' : undefined}
        data-interactive={actions ? '' : undefined}
        data-armed={armed ? '' : undefined}
        style={{ '--hook-preview-font': `${fontPx}px` } as CSSProperties}
        onPointerMove={actions ? track : undefined}
        onPointerDown={actions ? track : undefined}
      >
        {/* The game's dialogue box and its own line, which an aligned card covers. */}
        <span className="hook-preview-dialogue" aria-hidden>
          <span className="hook-preview-game-text" lang={line.lang}>
            {text}
          </span>
        </span>
        <span
          ref={card}
          className="hook-card hook-preview-card"
          data-ocr-theme={theme}
          data-surface={theme === 'blend' ? PREVIEW_SURFACE.ink : undefined}
          data-dragging={dragging ? '' : undefined}
          data-placed={placed ? '' : undefined}
          style={
            {
              '--hook-card-opacity': opacity,
              '--ocr-surface-top': PREVIEW_SURFACE.top,
              '--ocr-surface-bottom': PREVIEW_SURFACE.bottom,
              ...(placed ? { left: `${place.x}px`, top: `${place.y}px` } : {}),
              ...(placed && size ? { minWidth: `${size.width}px`, minHeight: `${size.height}px` } : {})
            } as CSSProperties
          }
        >
          <span className="hook-card-bar" {...dragHandlers('move')} />
          <span className="hook-card-controls">
            {actions ? (
              <>
                <button
                  type="button"
                  className="hook-card-button"
                  aria-label="Smaller text"
                  tabIndex={armed ? 0 : -1}
                  onClick={() => armed && actions.onTextSize(stepTextSize(textSize, -1))}
                >
                  <AArrowDown />
                </button>
                <button
                  type="button"
                  className="hook-card-button"
                  aria-label="Larger text"
                  tabIndex={armed ? 0 : -1}
                  onClick={() => armed && actions.onTextSize(stepTextSize(textSize, 1))}
                >
                  <AArrowUp />
                </button>
                <button
                  type="button"
                  className="hook-card-button hook-card-more"
                  aria-label="Card options"
                  aria-expanded={Boolean(menu)}
                  tabIndex={armed ? 0 : -1}
                  onClick={toggleMenu}
                >
                  <Ellipsis />
                </button>
              </>
            ) : (
              <>
                <span className="hook-card-button">
                  <AArrowDown />
                </span>
                <span className="hook-card-button">
                  <AArrowUp />
                </span>
                <span className="hook-card-button hook-card-more">
                  <Ellipsis />
                </span>
              </>
            )}
          </span>
          <span className="hook-card-resize" {...dragHandlers('resize')} />
          {actions && (
            <span className="hook-card-menu" hidden={!menu} data-below={menu === 'below' ? '' : undefined}>
              <span className="hook-card-menu-label">Opacity</span>
              <span className="hook-card-opacities">
                {OPACITIES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="hook-card-opacity"
                    data-current={value === opacity ? '' : undefined}
                    onClick={() => {
                      actions.onOpacity(value)
                      setMenu(null)
                    }}
                  >
                    {Math.round(value * 100)}%
                  </button>
                ))}
              </span>
            </span>
          )}
          <span className="hook-card-text" lang={line.lang} aria-hidden>
            {text}
          </span>
        </span>
        {actions && (
          <span className="hook-preview-hint" aria-hidden={armed}>
            {clickThrough === false ? (
              'Move the card by its top edge, resize it from its corner, or use its buttons'
            ) : (
              <>
                Hold <Kbd>{lookupKeyName(key, os === 'macos')}</Kbd> to move the card by its top edge, resize it from
                its corner, or use its buttons
              </>
            )}
          </span>
        )}
      </span>
    </div>
  )
}
