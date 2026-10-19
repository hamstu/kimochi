/**
 * The interactive demo on the home page.
 *
 * Desktop platforms: a synthetic visual novel (GameScreen, original CSS/SVG art) in a decorated game
 * window, with Kimochi's overlay drawn over it, beside the REAL Log window: the app's React UI built
 * from the preview harness (vite.demo.config.ts → /demo/panel.html) with the Tauri runtime mocked,
 * embedded in an iframe and driven by postMessage, so each line the game shows arrives in the Log.
 *
 * The platform comes in as a prop (the home page's PlatformStrip is the selector).
 *
 * The stage can be maximised to fill the browser window (Esc or the button restores it). On a
 * desktop platform the game and the Log then become free windows on a full-size desktop: drag them
 * by their title bars, resize them from the corner, click one to bring it to the front, and the Log
 * is wide enough for its sidebar. The same elements carry both layouts, so the Log's iframe (and
 * the lines it has gathered) survives the switch.
 *
 * Steam Deck: one handheld screen and the controller flow (both sticks → radial menu → Scan → D-pad
 * word to word → A reads → B back).
 *
 * The example game comes from frontend/dev/demo-content.ts (shared with the harness). The run pauses
 * offscreen and in hidden tabs, and with prefers-reduced-motion shows one still frame, popup open.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { GAME } from './content'
import { guessPlatform, useOnScreen, useReducedMotion, useResolvedTheme, type Platform } from './env'
import { deckFrames, desktopFrames, usePlayer, type Frame } from './script'
import { GameScreen } from './GameScreen'
import { DeckBody, DeckHud } from './DeckStage'
import { LogFrame, type LogDrag, type PostToLog } from './LogFrame'
import { DesktopBar, Taskbar, TitleBar, WINDOW_SHAPE } from './chrome'
import { PLAY_LINES } from './content'
import './demo.css'

export interface LiveDemoProps {
  className?: string
  /** The platform to show (the home page's platform strip drives it); defaults to the visitor's OS. */
  platform?: Platform
}

const DESKTOP_FRAMES = desktopFrames()
const DECK_FRAMES = deckFrames()

type WindowId = 'game' | 'log'
interface Placement {
  x: number
  y: number
  width: number
  /** The Log's height; the game's follows its width (a 16:10 screen under a title bar). */
  height: number
}
type Layout = Record<WindowId, Placement>

const GAP = 24
const MIN = { game: { width: 360, height: 0 }, log: { width: 380, height: 320 } }

/** Where the windows start on a maximised desktop of `width` × `height`: game left, Log right. */
function initialLayout(width: number, height: number): Layout {
  const logWidth = Math.round(Math.min(680, Math.max(560, width * 0.38)))
  const logHeight = Math.max(MIN.log.height, height - GAP * 2)
  const room = width - logWidth - GAP * 3
  const gameWidth = Math.round(Math.max(MIN.game.width, Math.min(room, (height - GAP * 2 - 32) * 1.6)))
  const gameHeight = gameWidth / 1.6 + 32
  return {
    game: { x: GAP, y: Math.max(GAP, Math.round((height - gameHeight) / 2)), width: gameWidth, height: 0 },
    log: { x: width - GAP - logWidth, y: GAP, width: logWidth, height: logHeight }
  }
}

/** The still frame for reduced motion: the first line, boxes up, popup open. */
function stillFrame(frames: Frame[]): Frame {
  return frames.find((f) => f.popup) ?? frames[0]
}

export function LiveDemo({ className = '', platform: chosen }: LiveDemoProps) {
  const [detected] = useState<Platform>(guessPlatform)
  const platform = chosen ?? detected
  const theme = useResolvedTheme()
  const reduced = useReducedMotion()
  const stageRef = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(stageRef, '0px')
  const near = useOnScreen(stageRef, '600px')
  const [loadLog, setLoadLog] = useState(false)
  useEffect(() => {
    if (near) setLoadLog(true)
  }, [near])

  const [userCursor, setUserCursor] = useState<number | null>(null)
  const deck = platform === 'deck'
  const frames = deck ? DECK_FRAMES : DESKTOP_FRAMES
  const postRef = useRef<PostToLog | null>(null)

  // ---------------------------------------------------------------- maximised desktop
  const [max, setMax] = useState(false)
  const deskRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<Layout | null>(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const [order, setOrder] = useState<WindowId[]>(['game', 'log'])
  // While the page drags or resizes a window, a shield over the Log keeps its iframe from taking
  // the pointer.
  const [busy, setBusy] = useState(false)
  const front = (id: WindowId): void => setOrder((o) => (o.at(-1) === id ? o : [...o.filter((w) => w !== id), id]))

  useLayoutEffect(() => {
    if (!max) return setLayout(null)
    const desk = deskRef.current
    if (desk) setLayout(initialLayout(desk.clientWidth, desk.clientHeight))
  }, [max, platform])

  useEffect(() => {
    if (!max) return
    const root = document.documentElement
    const overflow = root.style.overflow
    root.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMax(false)
    }
    addEventListener('keydown', onKey)
    return () => {
      root.style.overflow = overflow
      removeEventListener('keydown', onKey)
    }
  }, [max])

  /** Keeps a window's title bar reachable: at least 48px of it stays on the desk. */
  const clamp = (p: Placement): Placement => {
    const desk = deskRef.current
    if (!desk) return p
    return {
      ...p,
      x: Math.min(Math.max(p.x, 48 - p.width), desk.clientWidth - 48),
      y: Math.min(Math.max(p.y, 0), desk.clientHeight - 32)
    }
  }

  /** A drag (move, or resize from the corner) of a window by the page's own pointer. */
  const track = (id: WindowId, kind: 'move' | 'resize') => (event: ReactPointerEvent<HTMLElement>) => {
    if (!layout || event.button !== 0) return
    if (kind === 'move' && (event.target as Element).closest('button, a')) return
    event.preventDefault()
    event.stopPropagation()
    front(id)
    const start = { x: event.clientX, y: event.clientY, place: layout[id] }
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    setBusy(true)
    const move = (e: PointerEvent): void => {
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      const p = start.place
      const next =
        kind === 'move'
          ? clamp({ ...p, x: p.x + dx, y: p.y + dy })
          : {
              ...p,
              width: Math.max(MIN[id].width, p.width + dx),
              height: id === 'log' ? Math.max(MIN.log.height, p.height + dy) : 0
            }
      setLayout((l) => (l ? { ...l, [id]: next } : l))
    }
    const up = (): void => {
      target.removeEventListener('pointermove', move)
      setBusy(false)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up, { once: true })
    target.addEventListener('pointercancel', up, { once: true })
  }

  // The Log's own title bar, reported from inside its iframe in screen coordinates.
  const logDrag = useRef<{ x: number; y: number; place: Placement } | null>(null)
  const onLogDrag = useCallback(
    (drag: LogDrag) => {
      if (!max) return
      if (drag.phase === 'start') {
        front('log')
        const l = layoutRef.current
        logDrag.current = l ? { x: drag.x, y: drag.y, place: l.log } : null
        return
      }
      const start = logDrag.current
      if (!start) return
      if (drag.phase === 'end') logDrag.current = null
      setLayout((l) =>
        l ? { ...l, log: clamp({ ...start.place, x: start.place.x + drag.x - start.x, y: start.place.y + drag.y - start.y }) } : l
      )
    },
    [max]
  )

  const onEnter = useCallback((frame: Frame) => {
    if (frame.emit === 'scan') postRef.current?.({ type: 'scan' })
    if (frame.emit === 'line') postRef.current?.({ type: 'line', text: PLAY_LINES[frame.line].text })
  }, [])

  const running = onScreen && !reduced && userCursor === null
  const playing = usePlayer(frames, running, onEnter, platform)
  const frame = reduced ? stillFrame(frames) : playing

  // A visitor's pick belongs to the line it was made on.
  useEffect(() => setUserCursor(null), [frame.line, platform])

  // Maximised, the Log has room for its sidebar.
  useEffect(() => {
    postRef.current?.({ type: 'sidebar', value: max })
  }, [max, loadLog])


  const screen = useMemo(
    () => (
      <GameScreen
        frame={frame}
        variant={deck ? 'deck' : 'desktop'}
        paused={!onScreen}
        userCursor={userCursor}
        onUserCursor={setUserCursor}
      >
        {deck && <DeckHud frame={frame} />}
      </GameScreen>
    ),
    [frame, deck, onScreen, userCursor]
  )

  const free = max && !deck && layout !== null
  const placed = (id: WindowId): CSSProperties | undefined => {
    if (!free) return undefined
    const p = layout[id]
    return {
      position: 'absolute',
      left: p.x,
      top: p.y,
      width: p.width,
      height: id === 'log' ? p.height : undefined,
      zIndex: order.indexOf(id) + 1
    }
  }
  const corner = (id: WindowId) =>
    free ? (
      <span
        aria-hidden="true"
        onPointerDown={track(id, 'resize')}
        className="kd-resize absolute right-0 bottom-0 z-10 size-4 cursor-nwse-resize"
      />
    ) : null

  return (
    <div className={`w-full ${className}`}>
      <div
        ref={stageRef}
        role={max ? 'dialog' : undefined}
        aria-modal={max || undefined}
        aria-label={max ? 'Kimochi demo, maximised' : undefined}
        className={
          max
            ? 'kd-stage fixed inset-0 z-[70] flex flex-col overflow-hidden'
            : 'kd-stage relative flex w-full [overflow-anchor:none] flex-col overflow-hidden rounded-xl border border-hairline lg:aspect-[16/10]'
        }
      >
        <button
          type="button"
          onClick={() => setMax((m) => !m)}
          aria-label={max ? 'Restore the demo' : 'Maximise the demo'}
          title={max ? 'Restore (Esc)' : 'Maximise'}
          className={`kd-max absolute z-[80] hidden place-items-center rounded-md md:grid ${
            deck ? 'top-2 right-2 size-7' : platform === 'windows' ? 'top-1 right-1 size-5' : 'top-0.5 right-1.5 size-5'
          }`}
        >
          {max ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
        </button>
        {deck ? (
          <div className="grid flex-1 place-items-center px-3 py-8 sm:px-8 lg:px-14">
            <DeckBody frame={frame}>{screen}</DeckBody>
          </div>
        ) : (
          <>
            <DesktopBar platform={platform} />
            <div
              ref={deskRef}
              className={
                max
                  ? 'relative min-h-0 flex-1'
                  : 'grid min-h-0 flex-1 gap-4 p-3 sm:p-5 lg:grid-cols-[1.75fr_1fr] lg:grid-rows-[minmax(0,1fr)] lg:items-center lg:gap-5 lg:p-6'
              }
            >
              <div
                className={`min-w-0 overflow-hidden ${WINDOW_SHAPE[platform]}`}
                style={placed('game')}
                onPointerDown={free ? () => front('game') : undefined}
              >
                <div onPointerDown={free ? track('game', 'move') : undefined} className={free ? 'cursor-default' : undefined}>
                  <TitleBar
                    platform={platform}
                    title={GAME.app}
                    icon={<span className="kd-game-icon block size-3.5 rounded-[3px]" aria-hidden="true" />}
                  />
                </div>
                {screen}
                {corner('game')}
              </div>
              <div
                className={free ? '' : 'relative h-[440px] min-h-0 lg:h-full'}
                style={placed('log')}
                onPointerDown={free ? () => front('log') : undefined}
              >
                <LogFrame
                  platform={platform}
                  theme={theme}
                  load={loadLog}
                  postRef={postRef}
                  onDrag={onLogDrag}
                  className="size-full"
                />
                {busy && <span className="absolute inset-0 z-10" aria-hidden="true" />}
                {corner('log')}
              </div>
            </div>
            {platform === 'windows' && <Taskbar />}
          </>
        )}
      </div>
    </div>
  )
}
