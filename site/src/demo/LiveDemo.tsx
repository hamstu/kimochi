/**
 * The interactive demo on the home page.
 *
 * Desktop platforms: a synthetic visual novel (GameScreen, original CSS/SVG art) in a decorated game
 * window, with Kimochi's overlay drawn over it, beside the REAL Log window: the app's React UI built
 * from the preview harness (vite.demo.config.ts → /demo/panel.html) with the Tauri runtime mocked,
 * embedded in an iframe and driven by postMessage, so each line the game shows arrives in the Log.
 *
 * From `lg` up the desktop is a small desktop of its own, paused behind a play button. Play runs a
 * session from the start with a virtual pointer: open the game from its desktop icon, open Kimochi,
 * choose the game as the source (the real Change source menu, inside the iframe), turn on Auto OCR,
 * and from then on the game's lines are read, boxed and looked up while the pointer follows the
 * words. The windows are free windows: drag them by their title bars (the Log's drag is reported
 * from its iframe), resize them from the corner, click one to bring it to the front. The stage can
 * also be maximised to fill the browser (Esc or the button restores it). Narrower screens, and
 * reduced motion, get the two windows stacked, already set up.
 *
 * The platform comes in as a prop: the visitor's OS for the Desktop tab, `deck` for Gaming mode.
 * Steam Deck: one handheld screen and the controller flow (both sticks → radial menu → Scan → D-pad
 * word to word → A reads → B back), playing on its own.
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
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { Maximize2, Minimize2, Play, RotateCcw } from 'lucide-react'
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
  /** The platform to show: the visitor's OS for the Desktop tab, `deck` for Gaming mode. */
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
const TITLE = 32
const MIN = { game: { width: 360, height: 0 }, log: { width: 380, height: 320 } }

/** Where the windows sit on a desk of `width` × `height`: the game left, the Log right, overlapping. */
function initialLayout(width: number, height: number): Layout {
  const logWidth = Math.round(Math.min(640, Math.max(540, width * 0.36)))
  const logHeight = Math.max(MIN.log.height, height - GAP * 2)
  const room = width - logWidth - GAP * 3
  const fit = (height - GAP * 2 - TITLE) * 1.6
  const gameWidth = Math.round(Math.max(MIN.game.width, Math.min(fit, Math.max(room, width * 0.6))))
  const gameHeight = gameWidth / 1.6 + TITLE
  return {
    game: { x: GAP, y: Math.max(GAP, Math.round((height - gameHeight) / 2)), width: gameWidth, height: 0 },
    log: { x: width - GAP - logWidth, y: GAP, width: logWidth, height: logHeight }
  }
}

/** The still frame for reduced motion: the first line, boxes up, popup open. */
function stillFrame(frames: Frame[]): Frame {
  return frames.find((f) => f.popup) ?? frames[0]
}

/** `min-width: 1024px` (Tailwind's lg), live. */
function useWide(): boolean {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    const list = matchMedia(query)
    const on = (): void => setWide(list.matches)
    list.addEventListener('change', on)
    return () => list.removeEventListener('change', on)
  }, [])
  return wide
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('stopped', 'AbortError'))
    })
  })

/** The virtual pointer: where it is on the desk, how long its move takes, and whether it is pressed. */
interface Pointer {
  x: number
  y: number
  ms: number
  down: boolean
  shown: boolean
}

type Phase = 'idle' | 'intro' | 'running'

export function LiveDemo({ className = '', platform: chosen }: LiveDemoProps) {
  const [detected] = useState<Platform>(guessPlatform)
  const platform = chosen ?? detected
  const theme = useResolvedTheme()
  const reduced = useReducedMotion()
  const wide = useWide()
  const stageRef = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(stageRef, '0px')
  const near = useOnScreen(stageRef, '600px')
  const [loadLog, setLoadLog] = useState(false)
  useEffect(() => {
    if (near) setLoadLog(true)
  }, [near])

  const deck = platform === 'deck'
  // The scripted session: a desktop from lg up, without reduced motion.
  const flow = !deck && wide && !reduced
  const [phase, setPhase] = useState<Phase>('idle')
  const [run, setRun] = useState(0)
  const [open, setOpen] = useState<Record<WindowId, boolean>>({ game: false, log: false })
  const [pointer, setPointer] = useState<Pointer>({ x: 0, y: 0, ms: 0, down: false, shown: false })
  const [logReady, setLogReady] = useState(false)

  // A new platform, or leaving the flow, starts over.
  useEffect(() => {
    setPhase('idle')
    setOpen({ game: false, log: false })
    setPointer((p) => ({ ...p, shown: false }))
  }, [platform, flow])

  const [userCursor, setUserCursor] = useState<number | null>(null)
  const frames = deck ? DECK_FRAMES : DESKTOP_FRAMES
  const postRef = useRef<PostToLog | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const onEnter = useCallback((frame: Frame) => {
    if (frame.emit === 'scan') postRef.current?.({ type: 'scan' })
    if (frame.emit === 'line') postRef.current?.({ type: 'line', text: PLAY_LINES[frame.line].text })
  }, [])

  // Gaming mode plays on its own; the desktop plays once its session is under way.
  const started = deck || (flow ? phase === 'running' : phase !== 'idle')
  const running = onScreen && !reduced && userCursor === null && started
  const playing = usePlayer(frames, running, onEnter, `${platform}:${run}`)
  const frame = reduced ? stillFrame(frames) : playing

  // A visitor's pick belongs to the line it was made on.
  useEffect(() => setUserCursor(null), [frame.line, platform])

  // ---------------------------------------------------------------- desk and windows
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
  const free = !deck && (wide || max)

  useLayoutEffect(() => {
    const desk = deskRef.current
    if (!free || !desk) return setLayout(null)
    const place = (): void => setLayout(initialLayout(desk.clientWidth, desk.clientHeight))
    place()
  }, [free, max, platform])

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
      y: Math.min(Math.max(p.y, 0), desk.clientHeight - TITLE)
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
    []
  )

  // ---------------------------------------------------------------- the scripted session

  /** A point on the desk for an element inside the Log's iframe (its centre), or null. */
  const pointInLog = (selector: string, match?: (el: Element) => boolean): { x: number; y: number; el: HTMLElement } | null => {
    const iframe = iframeRef.current
    const desk = deskRef.current
    const doc = iframe?.contentDocument
    if (!iframe || !desk || !doc) return null
    const el = [...doc.querySelectorAll<HTMLElement>(selector)].find((e) => (match ? match(e) : true) && e.getClientRects().length > 0)
    if (!el) return null
    const f = iframe.getBoundingClientRect()
    const d = desk.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: f.left - d.left + r.left + r.width / 2, y: f.top - d.top + r.top + r.height / 2, el }
  }

  /** A point on the desk for an element of the page itself (its centre). */
  const pointOnDesk = (el: Element | null): { x: number; y: number } | null => {
    const desk = deskRef.current
    if (!el || !desk) return null
    const d = desk.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: r.left - d.left + r.width / 2, y: r.top - d.top + r.height / 2 }
  }

  useEffect(() => {
    if (!flow || phase !== 'intro') return
    const ctrl = new AbortController()
    const { signal } = ctrl
    const wait = (ms: number): Promise<void> => sleep(ms, signal)
    const moveTo = async (p: { x: number; y: number } | null, ms = 700): Promise<void> => {
      if (!p) throw new Error('target missing')
      setPointer((c) => ({ ...c, x: p.x, y: p.y, ms, shown: true }))
      await wait(ms + 80)
    }
    const press = async (times = 1): Promise<void> => {
      for (let i = 0; i < times; i++) {
        setPointer((c) => ({ ...c, down: true }))
        await wait(110)
        setPointer((c) => ({ ...c, down: false }))
        await wait(110)
      }
    }
    /** Waits for an element inside the Log, polling, up to `ms`. */
    const findInLog = async (selector: string, match?: (el: Element) => boolean, ms = 4000) => {
      for (let t = 0; t < ms; t += 100) {
        const hit = pointInLog(selector, match)
        if (hit) return hit
        await wait(100)
      }
      throw new Error(`not found: ${selector}`)
    }
    const tap = (el: HTMLElement, kind: 'pointer' | 'click'): void => {
      const win = el.ownerDocument.defaultView
      if (!win) return
      if (kind === 'pointer') {
        const r = el.getBoundingClientRect()
        const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
        el.dispatchEvent(new win.PointerEvent('pointerdown', init))
        el.dispatchEvent(new win.PointerEvent('pointerup', { ...init, buttons: 0 }))
      } else el.click()
    }

    void (async () => {
      const desk = deskRef.current
      if (!desk) return
      setPointer({ x: desk.clientWidth * 0.5, y: desk.clientHeight * 0.62, ms: 0, down: false, shown: true })
      await wait(350)
      // 1. Open the game from its desktop icon.
      await moveTo(pointOnDesk(desk.querySelector('[data-icon="game"]')), 900)
      await press(2)
      setOpen((o) => ({ ...o, game: true }))
      front('game')
      await wait(1100)
      // 2. Open Kimochi.
      await moveTo(pointOnDesk(desk.querySelector('[data-icon="kimochi"]')), 900)
      await press(2)
      setOpen((o) => ({ ...o, log: true }))
      front('log')
      await wait(1200)
      // 3. Choose a source → Window or screen → the game.
      const card = await findInLog('.src-empty')
      await moveTo(card, 800)
      await press()
      tap(card.el, 'pointer')
      await wait(500)
      const type = await findInLog('.src-type')
      await moveTo(type, 500)
      await press()
      tap(type.el, 'click')
      await wait(700)
      const tile = await findInLog('.sg-tile', (el) => /steins/i.test(el.getAttribute('title') ?? ''))
      await moveTo(tile, 750)
      await press()
      tap(tile.el, 'click')
      await wait(900)
      // 4. Auto OCR on.
      const auto = await findInLog('button[role="switch"]', (el) => /Auto OCR/.test(el.textContent ?? ''))
      await moveTo(auto, 750)
      await press()
      tap(auto.el, 'click')
      await wait(500)
      // 5. The game's lines start arriving; the pointer goes back to the game.
      front('game')
      setPhase('running')
    })().catch((error: unknown) => {
      if ((error as Error)?.name === 'AbortError') return
      // Something inside the Log did not show up as expected: skip ahead rather than stall.
      setOpen({ game: true, log: true })
      setPhase('running')
    })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, phase, run])

  // While the session plays, the pointer follows the word being looked up, else rests by the box.
  useEffect(() => {
    if (!flow || phase !== 'running') return
    const desk = deskRef.current
    if (!desk) return
    const t = setTimeout(() => {
      const word = desk.querySelector('.kd-word.kd-current')
      const box = desk.querySelector('.kd-box')
      const target = word ? pointOnDesk(word) : box ? pointOnDesk(box) : null
      if (!target) return
      const offset = word ? { x: 4, y: 10 } : { x: 120, y: 60 }
      setPointer((c) => ({ ...c, x: target.x + offset.x, y: target.y + offset.y, ms: 650, shown: true }))
    }, 60)
    return () => clearTimeout(t)
  }, [flow, phase, frame])

  // The visitor's own pointer on the desk hides the virtual one for a moment.
  const [userActive, setUserActive] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDeskMove = (): void => {
    if (phase !== 'running') return
    setUserActive(true)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setUserActive(false), 3000)
  }

  const play = (): void => {
    setUserCursor(null)
    if (!flow) return setPhase('running')
    setOpen({ game: false, log: false })
    setLogReady(false)
    setRun((r) => r + 1)
    setPhase('intro')
  }

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

  const placed = (id: WindowId): CSSProperties | undefined => {
    if (!free || !layout) return undefined
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
    free && layout ? (
      <span
        aria-hidden="true"
        onPointerDown={track(id, 'resize')}
        className="kd-resize absolute right-0 bottom-0 z-10 size-4 cursor-nwse-resize"
      />
    ) : null
  // In the flow, a window shows once it has been opened.
  const shown = (id: WindowId): boolean => !flow || open[id]
  const logParams: Record<string, string> = flow ? { nosource: '1', auto: '0', sidebar: '1' } : { sidebar: free ? '1' : '0' }
  const showPlay = !deck && !reduced && phase === 'idle'

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
        <div className="absolute top-0 right-0 z-[80] hidden items-center gap-1 p-0.5 md:flex">
          {flow && phase === 'running' && (
            <button type="button" onClick={play} aria-label="Play the demo again" title="Play again" className="kd-max grid size-5 place-items-center rounded-md">
              <RotateCcw size={12} aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={() => setMax((m) => !m)}
            aria-label={max ? 'Restore the demo' : 'Maximise the demo'}
            title={max ? 'Restore (Esc)' : 'Maximise'}
            className={`kd-max grid place-items-center rounded-md ${deck ? 'm-1.5 size-7' : 'mr-1 size-5'}`}
          >
            {max ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
          </button>
        </div>
        {deck ? (
          <div className="grid flex-1 place-items-center px-3 py-8 sm:px-8 lg:px-14">
            <DeckBody frame={frame}>{screen}</DeckBody>
          </div>
        ) : (
          <>
            <DesktopBar platform={platform} />
            <div
              ref={deskRef}
              onPointerMove={onDeskMove}
              className={
                free
                  ? 'relative min-h-[560px] flex-1'
                  : 'relative grid min-h-0 flex-1 gap-4 p-3 sm:p-5'
              }
            >
              {flow && (
                <div className={`kd-icons absolute top-4 flex flex-col gap-4 ${platform === 'macos' ? 'right-5' : 'left-5'}`}>
                  <DesktopIcon id="game" label={GAME.app} icon={<span className="kd-game-icon block size-9 rounded-lg" />} onOpen={() => setOpen((o) => ({ ...o, game: true }))} />
                  <DesktopIcon id="kimochi" label="Kimochi" icon={<img src="/icon.svg" alt="" className="size-10" />} onOpen={() => setOpen((o) => ({ ...o, log: true }))} />
                </div>
              )}
              <div
                className={`min-w-0 overflow-hidden ${WINDOW_SHAPE[platform]} ${shown('game') ? 'kd-win-open' : 'kd-win-closed'}`}
                style={placed('game')}
                onPointerDown={free ? () => front('game') : undefined}
              >
                <div onPointerDown={free ? track('game', 'move') : undefined}>
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
                className={`${free ? '' : 'relative h-[440px] min-h-0'} ${shown('log') ? 'kd-win-open' : 'kd-win-closed'}`}
                style={placed('log')}
                onPointerDown={free ? () => front('log') : undefined}
              >
                <LogFrame
                  platform={platform}
                  theme={theme}
                  load={loadLog}
                  postRef={postRef}
                  onDrag={onLogDrag}
                  params={logParams}
                  reloadKey={run}
                  iframeRef={iframeRef}
                  onLoaded={() => setLogReady(true)}
                  className="size-full"
                />
                {busy && <span className="absolute inset-0 z-10" aria-hidden="true" />}
                {corner('log')}
              </div>
              {flow && (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 24"
                  className={`kd-pointer pointer-events-none absolute top-0 left-0 z-[60] ${pointer.down ? 'kd-pointer-down' : ''}`}
                  style={{
                    transform: `translate(${pointer.x}px, ${pointer.y}px)`,
                    transitionDuration: `${pointer.ms}ms`,
                    opacity: pointer.shown && !userActive ? 1 : 0
                  }}
                >
                  <path d="M2 1.5v18.2l4.6-4.4 3 6.8 3.1-1.4-3-6.6h6.4z" />
                </svg>
              )}
              {showPlay && (
                <button
                  type="button"
                  onClick={play}
                  disabled={flow && !logReady && loadLog}
                  aria-label="Play the demo"
                  className="kd-play absolute top-1/2 left-1/2 z-[70] grid size-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
                >
                  <Play size={30} aria-hidden className="translate-x-0.5" fill="currentColor" />
                </button>
              )}
            </div>
            {platform === 'windows' && <Taskbar />}
          </>
        )}
      </div>
    </div>
  )
}

/** A desktop icon: picture over a label; a double-click opens it (the virtual pointer's way too). */
function DesktopIcon({ id, label, icon, onOpen }: { id: string; label: string; icon: ReactNode; onOpen: () => void }) {
  return (
    <button type="button" data-icon={id} onDoubleClick={onOpen} className="kd-icon flex w-20 flex-col items-center gap-1.5 rounded-md p-1.5">
      <span className="grid size-11 place-items-center">{icon}</span>
      <span className="max-w-full truncate px-1 text-[11px] font-medium">{label}</span>
    </button>
  )
}
