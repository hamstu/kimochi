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
 * click back on the game, and from then on the pointer follows the words being looked up. The
 * visitor's first click of their own retires the virtual pointer for good.
 *
 * The windows behave like windows, through a few light shims (frontend/dev/preview-setup.ts):
 * drag them by their title bars (the Log's drag is reported from its iframe), resize them from the
 * corner, click one to bring it to the front, close them (the desktop icons open them again), and
 * Kimochi's mini mode shrinks its window. Positions are fractions of the desk, so maximising the
 * stage to fill the browser (Esc or the button restores it) scales everything with it. The Log is
 * told which windows are open, so its source menu offers only those; it reports its source and
 * switches back, so the game is read only while Kimochi watches it with Auto OCR on, and the overlay
 * shows only with Show overlay on. An Easter egg in the corner opens a small app that can be read
 * too. Narrower screens, and reduced motion, get the two windows stacked, already set up.
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
import { Maximize2, Play, RotateCcw, X } from 'lucide-react'
import { useMediaQuery } from '../lib/client'
import { GAME } from './content'
import { useGuessedPlatform, useOnScreen, useReducedMotion, useResolvedTheme, type Platform } from './env'
import { deckFrames, desktopFrames, usePlayer, type Frame } from './script'
import { GameScreen } from './GameScreen'
import { DeckBody, DeckHud } from './DeckStage'
import { LogFrame, type LogEvent, type PostToLog } from './LogFrame'
import { DesktopBar, Taskbar, TitleBar, WINDOW_SHAPE } from './chrome'
import { EGG_LINE, EggApp } from './EggApp'
import { TryRealThing } from './TryRealThing'
import { PLAY_LINES } from './content'
import './demo.css'

export interface LiveDemoProps {
  className?: string
  /** The platform to show: the visitor's OS for the Desktop tab, `deck` for Gaming mode. */
  platform?: Platform
}

const DESKTOP_FRAMES = desktopFrames()
const DECK_FRAMES = deckFrames()

/** The harness's source ids for the site's own windows (preview-setup.ts). */
const GAME_SOURCE = 'window:101'
const EGG_SOURCE = 'window:900'

type WindowId = 'game' | 'log' | 'egg'
/** A window's place as fractions of the desk; the game's height follows its width (16:10 + title). */
interface Placement {
  x: number
  y: number
  w: number
  h: number
}
type Layout = Record<WindowId, Placement>
interface Size {
  width: number
  height: number
}

const TITLE = 32
/** Kimochi's mini mode, as the app sizes it (src-tauri/src/compact.rs). */
const MINI = { width: 320, height: 560 }
const MIN = { width: 300, height: 260 }

const gameHeight = (w: number, desk: Size): number => (w * desk.width) / 1.6 + TITLE

/** Where the windows open: Kimochi large on the right (about five-eighths), the game bottom-left. */
function initialLayout(desk: Size): Layout {
  let gw = 0.42
  if (gameHeight(gw, desk) > desk.height * 0.62) gw = ((desk.height * 0.62 - TITLE) * 1.6) / desk.width
  return {
    log: { x: 0.32, y: 0.06, w: 0.64, h: 0.8 },
    game: { x: 0.035, y: 1 - 0.05 - gameHeight(gw, desk) / desk.height, w: gw, h: 0 },
    egg: { x: 0.3, y: 0.18, w: 0.36, h: 0.46 }
  }
}

/** The still frame for reduced motion: the first line, boxes up, popup open. */
function stillFrame(frames: Frame[]): Frame {
  return frames.find((f) => f.popup) ?? frames[0]
}

/** `min-width: 1024px` (Tailwind's lg), live. */
function useWide(): boolean {
  return useMediaQuery('(min-width: 1024px)')
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
  const detected = useGuessedPlatform()
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
  const [max, setMax] = useState(false)
  /** What the visitor reached that only the app can do, offered as a download. */
  const [unavailable, setUnavailable] = useState<string | null>(null)
  // Free windows on a desk: from lg up, or maximised.
  const free = !deck && (wide || max)
  // The scripted session: on the desk, without reduced motion.
  const flow = free && !reduced
  const [phase, setPhase] = useState<Phase>('idle')
  const [run, setRun] = useState(0)
  const [open, setOpen] = useState<Record<WindowId, boolean>>({ game: false, log: false, egg: false })
  // Kimochi's Quit, as opposed to its window being hidden or minimised: nothing is read until it is
  // opened again.
  const [quit, setQuit] = useState(false)
  const [pointer, setPointer] = useState<Pointer>({ x: 0, y: 0, ms: 0, down: false, shown: false })
  // The visitor took over: the virtual pointer is gone until the demo is played again.
  const [retired, setRetired] = useState(false)
  const [logReady, setLogReady] = useState(false)
  const [logState, setLogState] = useState<{ sourceId: string | null; autoOcr: boolean; overlay: boolean }>({
    sourceId: null,
    autoOcr: false,
    overlay: false
  })

  // A new platform, or a different kind of stage, starts over.
  useEffect(() => {
    setPhase('idle')
    setOpen({ game: false, log: false, egg: false })
    setQuit(false)
    setRetired(false)
    setPointer((p) => ({ ...p, shown: false }))
  }, [platform, flow])

  const [userCursor, setUserCursor] = useState<number | null>(null)
  const frames = deck ? DECK_FRAMES : DESKTOP_FRAMES
  const postRef = useRef<PostToLog | null>(null)
  // No sound from a demo the visitor cannot see: scrolled away, or another tab.
  useEffect(() => {
    postRef.current?.({ type: 'muted', value: !onScreen })
  }, [onScreen, logReady])
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const onEnter = useCallback((frame: Frame) => {
    if (frame.emit === 'scan') postRef.current?.({ type: 'scan' })
    if (frame.emit === 'line') postRef.current?.({ type: 'line', text: PLAY_LINES[frame.line].text })
  }, [])

  // Kimochi is reading a window: it is running (not quit), and that window is its source with Auto
  // OCR on. Off the desk the windows are always open.
  const watching = (id: WindowId, source: string): boolean =>
    (!free || (open[id] && !quit)) && logState.sourceId === source && logState.autoOcr
  const started = deck || phase !== 'idle'
  const reading = deck || (started && watching('game', GAME_SOURCE))
  const running = onScreen && !reduced && userCursor === null && reading
  const playing = usePlayer(frames, running, onEnter, `${platform}:${run}`)
  const frame = reduced ? stillFrame(frames) : playing
  const overlay = deck || reduced || ((!free || (open.game && !quit)) && logState.sourceId === GAME_SOURCE && logState.overlay)

  // A visitor's pick belongs to the line it was made on.
  useEffect(() => setUserCursor(null), [frame.line, platform])

  // The Easter egg's app is read once each time Kimochi starts watching it.
  // Once read, its words take the overlay's boxes, until Kimochi stops watching it.
  const eggRead = started && watching('egg', EGG_SOURCE)
  const [eggScanned, setEggScanned] = useState(false)
  useEffect(() => {
    setEggScanned(false)
    if (!eggRead || !onScreen) return
    const scan = setTimeout(() => postRef.current?.({ type: 'scan' }), 700)
    const line = setTimeout(() => {
      postRef.current?.({ type: 'line', text: EGG_LINE })
      setEggScanned(true)
    }, 1600)
    return () => {
      clearTimeout(scan)
      clearTimeout(line)
    }
  }, [eggRead, onScreen])
  const eggBoxes = eggScanned && eggRead && logState.overlay

  // ---------------------------------------------------------------- desk and windows
  const deskRef = useRef<HTMLDivElement>(null)
  const [desk, setDesk] = useState<Size | null>(null)
  const [layout, setLayout] = useState<Layout | null>(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const deskSize = useRef(desk)
  deskSize.current = desk
  const [order, setOrder] = useState<WindowId[]>(['egg', 'game', 'log'])
  // While the page drags or resizes a window, a shield over the Log keeps its iframe from taking
  // the pointer.
  const [busy, setBusy] = useState(false)
  const front = useCallback(
    (id: WindowId): void => setOrder((o) => (o.at(-1) === id ? o : [...o.filter((w) => w !== id), id])),
    []
  )
  const beforeMini = useRef<Placement | null>(null)

  useLayoutEffect(() => {
    const el = deskRef.current
    if (!free || !el) {
      setDesk(null)
      return
    }
    const measure = (): void => setDesk({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [free])

  // Laid out once per desk (and per replay); afterwards fractions keep it in proportion.
  const hasDesk = desk !== null
  useLayoutEffect(() => {
    const d = deskSize.current
    if (!d) return setLayout(null)
    setLayout((l) => l ?? initialLayout(d))
  }, [hasDesk, platform, run])

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

  /** Keeps a window's title bar reachable: some of it stays on the desk. */
  const clamp = (p: Placement, d: Size): Placement => ({
    ...p,
    x: Math.min(Math.max(p.x, 48 / d.width - p.w), 1 - 48 / d.width),
    y: Math.min(Math.max(p.y, 0), 1 - TITLE / d.height)
  })

  /** A drag (move, or resize from the corner) of a window by the page's own pointer. */
  const track = (id: WindowId, kind: 'move' | 'resize') => (event: ReactPointerEvent<HTMLElement>) => {
    if (!layout || !desk || event.button !== 0) return
    if (kind === 'move' && (event.target as Element).closest('button, a')) return
    event.preventDefault()
    event.stopPropagation()
    if (phase === 'running') setRetired(true)
    front(id)
    const start = { x: event.clientX, y: event.clientY, place: layout[id] }
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    setBusy(true)
    const move = (e: PointerEvent): void => {
      const d = deskSize.current ?? desk
      const dx = (e.clientX - start.x) / d.width
      const dy = (e.clientY - start.y) / d.height
      const p = start.place
      const next =
        kind === 'move'
          ? clamp({ ...p, x: p.x + dx, y: p.y + dy }, d)
          : { ...p, w: Math.max(MIN.width / d.width, p.w + dx), h: Math.max(MIN.height / d.height, p.h + dy) }
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

  // ---------------------------------------------------------------- what the Log reports
  const logDrag = useRef<{ x: number; y: number; place: Placement } | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const onLogEvent = (event: LogEvent): void => {
    if (event.type === 'state') {
      setLogState({ sourceId: event.sourceId, autoOcr: event.autoOcr, overlay: event.overlay })
    } else if (event.type === 'unavailable') {
      setUnavailable(event.feature)
    } else if (event.type === 'interact') {
      front('log')
      if (phaseRef.current === 'running') setRetired(true)
    } else if (event.type === 'activate') {
      if (event.sourceId === GAME_SOURCE) front('game')
      if (event.sourceId === EGG_SOURCE) front('egg')
    } else if (event.type === 'window') {
      const action = event.action
      if (action === 'close' || action === 'hide' || action === 'minimize') {
        setOpen((o) => ({ ...o, log: false }))
        if (action === 'close') setQuit(true)
        return
      }
      // The saved size is read and written here, not in the state updater (which may run twice).
      const d = deskSize.current
      const l = layoutRef.current
      if (!l || !d) return
      if (action === 'mini') {
        if (!beforeMini.current) beforeMini.current = l.log
        const mini = { ...l.log, w: MINI.width / d.width, h: Math.min(MINI.height / d.height, 1 - l.log.y) }
        setLayout((cur) => (cur ? { ...cur, log: mini } : cur))
      } else {
        const back = beforeMini.current
        beforeMini.current = null
        if (back) setLayout((cur) => (cur ? { ...cur, log: back } : cur))
      }
    } else if (event.type === 'drag') {
      const d = deskSize.current
      if (event.phase === 'start') {
        front('log')
        const l = layoutRef.current
        logDrag.current = l ? { x: event.x, y: event.y, place: l.log } : null
        return
      }
      const start = logDrag.current
      if (!start || !d) return
      if (event.phase === 'end') logDrag.current = null
      const next = clamp(
        { ...start.place, x: start.place.x + (event.x - start.x) / d.width, y: start.place.y + (event.y - start.y) / d.height },
        d
      )
      setLayout((l) => (l ? { ...l, log: next } : l))
    }
  }

  // The Log offers only the site's windows that are open.
  const openSources = [open.game && GAME_SOURCE, open.egg && EGG_SOURCE].filter(Boolean).join(',')
  useEffect(() => {
    if (!free || !logReady) return
    postRef.current?.({ type: 'sources', open: openSources ? openSources.split(',') : [] })
  }, [free, logReady, openSources])

  // ---------------------------------------------------------------- the scripted session

  /** A point on the desk for an element inside the Log's iframe (its centre), or null. */
  const pointInLog = (selector: string, match?: (el: Element) => boolean): { x: number; y: number; el: HTMLElement } | null => {
    const iframe = iframeRef.current
    const deskEl = deskRef.current
    const doc = iframe?.contentDocument
    if (!iframe || !deskEl || !doc) return null
    const el = [...doc.querySelectorAll<HTMLElement>(selector)].find((e) => (match ? match(e) : true) && e.getClientRects().length > 0)
    if (!el) return null
    const f = iframe.getBoundingClientRect()
    const d = deskEl.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: f.left - d.left + r.left + r.width / 2, y: f.top - d.top + r.top + r.height / 2, el }
  }

  /** A point on the desk inside an element of the page itself (`fx`, `fy` of the way across it). */
  const pointOnDesk = (el: Element | null, fx = 0.5, fy = 0.5): { x: number; y: number } | null => {
    const d = deskRef.current
    if (!el || !d) return null
    const dr = d.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: r.left - dr.left + r.width * fx, y: r.top - dr.top + r.height * fy }
  }

  const steps = useRef({ pointInLog, pointOnDesk, front })
  steps.current = { pointInLog, pointOnDesk, front }

  useEffect(() => {
    if (!flow || phase !== 'intro') return
    const { pointInLog: inLog, pointOnDesk: onDesk, front: raise } = steps.current
    const ctrl = new AbortController()
    const { signal } = ctrl
    const wait = (ms: number): Promise<void> => sleep(ms, signal)
    const moveTo = async (p: { x: number; y: number } | null, ms = 700): Promise<void> => {
      if (!p) throw new Error('target missing')
      setPointer((c) => ({ ...c, x: p.x, y: p.y, ms, shown: true }))
      await wait(ms + 80)
    }
    // `sound`: a click on the demo's own desktop (an icon, a window), which has no sound of its
    // own. Clicks inside Kimochi are not given one: its controls already sound. A double-click
    // sounds once, like an app's sound effect, not twice like a mouse.
    const press = async (times = 1, sound = false): Promise<void> => {
      for (let i = 0; i < times; i++) {
        if (sound && i === 0) postRef.current?.({ type: 'sound', name: 'click' })
        setPointer((c) => ({ ...c, down: true }))
        await wait(110)
        setPointer((c) => ({ ...c, down: false }))
        await wait(110)
      }
    }
    /** Waits for an element inside the Log, polling, up to `ms`. */
    const findInLog = async (selector: string, match?: (el: Element) => boolean, ms = 4000) => {
      for (let t = 0; t < ms; t += 100) {
        const hit = inLog(selector, match)
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
    const windowEl = (id: WindowId): Element | null => deskRef.current?.querySelector(`[data-window="${id}"]`) ?? null

    void (async () => {
      const el = deskRef.current
      if (!el) return
      setPointer({ x: el.clientWidth * 0.5, y: el.clientHeight * 0.62, ms: 0, down: false, shown: true })
      await wait(350)
      // 1. Open the game from its desktop icon.
      await moveTo(onDesk(el.querySelector('[data-icon="game"]')), 900)
      await press(2, true)
      setOpen((o) => ({ ...o, game: true }))
      raise('game')
      await wait(1100)
      // 2. Open Kimochi.
      await moveTo(onDesk(el.querySelector('[data-icon="kimochi"]')), 900)
      await press(2, true)
      setOpen((o) => ({ ...o, log: true }))
      setQuit(false)
      raise('log')
      await wait(1100)
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
      const tile = await findInLog('.sg-tile', (e) => /steins/i.test(e.getAttribute('title') ?? ''))
      await moveTo(tile, 750)
      await press()
      tap(tile.el, 'click')
      await wait(900)
      // 4. Auto OCR on.
      const auto = await findInLog('button[role="switch"]', (e) => /Auto OCR/.test(e.textContent ?? ''))
      await moveTo(auto, 750)
      await press()
      tap(auto.el, 'click')
      await wait(600)
      // 5. Back to the game: click its uncovered side to bring it forward, and read.
      await moveTo(onDesk(windowEl('game'), 0.22, 0.55), 800)
      await press(1, true)
      raise('game')
      setPhase('running')
    })().catch((error: unknown) => {
      if ((error as Error)?.name === 'AbortError') return
      // Something inside the Log did not show up as expected: skip ahead rather than stall.
      setOpen((o) => ({ ...o, game: true, log: true }))
      setPhase('running')
    })
    return () => ctrl.abort()
  }, [flow, phase, run])

  // While the session plays, the pointer follows the word being looked up, else rests by the box.
  // A scripted lookup opens only once the pointer has reached its word (`arrived`).
  const [arrived, setArrived] = useState<Frame | null>(null)
  useEffect(() => {
    if (!flow || phase !== 'running' || retired) return
    const deskEl = deskRef.current
    if (!deskEl) return
    const MOVE = 650
    let landed: ReturnType<typeof setTimeout> | undefined
    const t = setTimeout(() => {
      const { pointOnDesk: onDesk } = steps.current
      const word = frame.cursor !== null ? deskEl.querySelector(`[data-window="game"] [data-token="${frame.cursor}"]`) : null
      const box = deskEl.querySelector('[data-window="game"] .kd-box')
      const target = word ? onDesk(word) : box ? onDesk(box, 0.7, 0.8) : null
      if (!target) return
      const offset = word ? { x: 4, y: 10 } : { x: 0, y: 0 }
      setPointer((c) => ({ ...c, x: target.x + offset.x, y: target.y + offset.y, ms: MOVE, shown: true }))
      landed = setTimeout(() => setArrived(frame), MOVE)
    }, 60)
    return () => {
      clearTimeout(t)
      clearTimeout(landed)
    }
  }, [flow, phase, frame, retired])
  // On the scripted desk, a frame's lookup waits for the pointer, and stops for good once the
  // visitor has taken over (their own hovering still opens words).
  const scripted = flow && phase === 'running'
  const shownFrame: Frame =
    scripted && (retired || arrived !== frame) ? { ...frame, cursor: null, popup: false } : frame

  /** The visitor's own click on the desk, once the session is under way, retires the pointer. */
  const onDeskDown = (event: ReactPointerEvent): void => {
    if (event.isTrusted && phase === 'running') setRetired(true)
  }

  const play = (): void => {
    setUserCursor(null)
    setRetired(false)
    if (!flow) return setPhase('running')
    setOpen({ game: false, log: false, egg: false })
    setQuit(false)
    setLayout(null)
    setLogReady(false)
    setRun((r) => r + 1)
    setPhase('intro')
  }

  // Out of the maximised demo first, once the page can scroll again.
  const toDownload = (): void => {
    setUnavailable(null)
    setMax(false)
    setTimeout(() => document.getElementById('get-kimochi')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }

  const screen = useMemo(
    () => (
      <GameScreen
        frame={shownFrame}
        variant={deck ? 'deck' : 'desktop'}
        paused={!onScreen}
        userCursor={userCursor}
        onUserCursor={setUserCursor}
        overlay={overlay}
      >
        {deck && <DeckHud frame={frame} />}
      </GameScreen>
    ),
    [frame, shownFrame, deck, onScreen, userCursor, overlay]
  )

  const placed = (id: WindowId): CSSProperties | undefined => {
    if (!free || !layout || !desk) return undefined
    const p = layout[id]
    return {
      position: 'absolute',
      left: p.x * desk.width,
      top: p.y * desk.height,
      width: p.w * desk.width,
      height: id === 'game' ? undefined : p.h * desk.height,
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
  // On the desk, a window shows once it has been opened.
  const shown = (id: WindowId): boolean => !free || open[id]
  const openWindow = (id: WindowId): void => {
    setOpen((o) => ({ ...o, [id]: true }))
    if (id === 'log') setQuit(false)
    front(id)
  }
  const close = (id: WindowId) => (free ? () => setOpen((o) => ({ ...o, [id]: false })) : undefined)
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
        <div
          className={`absolute right-0 z-[80] flex items-center gap-1 ${max ? 'top-[env(safe-area-inset-top)] p-2' : 'top-0 p-0.5'}`}
        >
          {flow && phase === 'running' && (
            <button
              type="button"
              onClick={play}
              aria-label="Play the demo again"
              title="Play again"
              className={`kd-max grid place-items-center ${max ? 'size-11 rounded-full md:size-9' : 'size-5 rounded-md'}`}
            >
              <RotateCcw size={max ? 16 : 12} aria-hidden />
            </button>
          )}
          {max ? (
            // Out of the maximised demo: big enough to hit with a thumb.
            <button
              type="button"
              onClick={() => setMax(false)}
              aria-label="Close the maximised demo"
              title="Close (Esc)"
              className="kd-max kd-max-close grid size-11 place-items-center rounded-full md:size-9"
            >
              <X size={20} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setMax(true)}
              aria-label="Maximise the demo"
              title="Maximise"
              className={`kd-max grid place-items-center rounded-md ${deck ? 'm-1.5 size-7' : 'mr-1 size-5'}`}
            >
              <Maximize2 size={14} aria-hidden />
            </button>
          )}
        </div>
        {deck ? (
          <div className="grid flex-1 place-items-center px-3 py-8 sm:px-8 lg:px-14">
            <DeckBody frame={frame}>{screen}</DeckBody>
          </div>
        ) : (
          <>
            <DesktopBar platform={platform} replay={flow && phase === 'running'} />
            <div
              ref={deskRef}
              onPointerDown={onDeskDown}
              className={free ? 'relative min-h-[560px] flex-1' : 'relative grid min-h-0 flex-1 gap-4 p-3 sm:p-5'}
            >
              {free && (
                <>
                  <div className="absolute top-4 left-5 flex flex-col gap-4">
                    <DesktopIcon id="game" label={GAME.app} icon={<span className="kd-game-icon block size-9 rounded-lg" />} onOpen={() => openWindow('game')} />
                    <DesktopIcon id="kimochi" label="Kimochi" icon={<img src="/icon.svg" alt="" className="size-10" />} onOpen={() => openWindow('log')} />
                  </div>
                  <div className="absolute right-5 bottom-4">
                    <DesktopIcon id="egg" label="おまけ" icon={<EggMark />} onOpen={() => openWindow('egg')} />
                  </div>
                </>
              )}
              <div
                data-window="game"
                className={`min-w-0 overflow-hidden ${WINDOW_SHAPE[platform]} ${shown('game') ? 'kd-win-open' : 'kd-win-closed'}`}
                style={placed('game')}
                onPointerDown={free ? () => front('game') : undefined}
              >
                <div onPointerDown={free ? track('game', 'move') : undefined}>
                  <TitleBar
                    platform={platform}
                    title={GAME.app}
                    icon={<span className="kd-game-icon block size-3.5 rounded-[3px]" aria-hidden="true" />}
                    onClose={close('game')}
                  />
                </div>
                {screen}
                {corner('game')}
              </div>
              <div
                data-window="log"
                className={`${free ? '' : 'relative h-[440px] min-h-0'} ${shown('log') ? 'kd-win-open' : 'kd-win-closed'}`}
                style={placed('log')}
                onPointerDown={free ? () => front('log') : undefined}
              >
                <LogFrame
                  platform={platform}
                  theme={theme}
                  load={loadLog}
                  postRef={postRef}
                  onEvent={onLogEvent}
                  params={logParams}
                  reloadKey={run}
                  iframeRef={iframeRef}
                  onLoaded={() => setLogReady(true)}
                  className="size-full"
                />
                {busy && <span className="absolute inset-0 z-10" aria-hidden="true" />}
                {corner('log')}
              </div>
              {free && (
                <div
                  data-window="egg"
                  className={`flex flex-col overflow-hidden bg-raised ${WINDOW_SHAPE[platform]} ${open.egg ? 'kd-win-open' : 'kd-win-closed'}`}
                  style={placed('egg')}
                  onPointerDown={() => front('egg')}
                >
                  <div onPointerDown={track('egg', 'move')}>
                    <TitleBar platform={platform} title="おまけ" icon={<EggMark small />} onClose={close('egg')} />
                  </div>
                  <EggApp boxes={eggBoxes} onDownload={toDownload} />
                  {corner('egg')}
                </div>
              )}
              {flow && (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 24"
                  className={`kd-pointer pointer-events-none absolute top-0 left-0 z-[60] ${pointer.down ? 'kd-pointer-down' : ''}`}
                  style={{
                    transform: `translate(${pointer.x}px, ${pointer.y}px)`,
                    transitionDuration: `${pointer.ms}ms`,
                    opacity: pointer.shown && !retired ? 1 : 0
                  }}
                >
                  <path d="M2 1.5v18.2l4.6-4.4 3 6.8 3.1-1.4-3-6.6h6.4z" />
                </svg>
              )}
              {showPlay && (
                <button
                  type="button"
                  // On a large screen, playing fills it for the full effect (Esc or the corner X
                  // restores it); a phone plays in place.
                  onClick={() => {
                    if (wide) setMax(true)
                    play()
                  }}
                  disabled={flow && loadLog && !logReady}
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
        {unavailable && !deck && (
          <TryRealThing platform={platform} feature={unavailable} onTry={toDownload} onClose={() => setUnavailable(null)} />
        )}
      </div>
    </div>
  )
}

/** A desktop icon: picture over a label; a double-click opens it (the virtual pointer's way too). */
function DesktopIcon({ id, label, icon, onOpen }: { id: string; label: string; icon: ReactNode; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-icon={id}
      onDoubleClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className="kd-icon flex w-20 flex-col items-center gap-1.5 rounded-md p-1.5"
    >
      <span className="grid size-11 place-items-center">{icon}</span>
      <span className="max-w-full truncate px-1 text-[11px] font-medium" lang={/[^\x20-\x7e]/.test(label) ? 'ja' : undefined}>
        {label}
      </span>
    </button>
  )
}

/** The Easter egg: a speckled egg. */
function EggMark({ small = false }: { small?: boolean }) {
  return (
    <svg viewBox="0 0 32 40" className={small ? 'size-3.5' : 'h-10 w-8'} aria-hidden="true">
      <path d="M16 1.5C8.5 1.5 2.5 15 2.5 25a13.5 13.5 0 0 0 27 0C29.5 15 23.5 1.5 16 1.5z" fill="#fff4dc" stroke="#e8c98a" strokeWidth="1.5" />
      <circle cx="11" cy="20" r="1.8" fill="#e6a8a0" />
      <circle cx="20" cy="15" r="1.4" fill="#9fc6e8" />
      <circle cx="19" cy="27" r="2" fill="#b9dca2" />
      <circle cx="10" cy="30" r="1.2" fill="#f2c45f" />
    </svg>
  )
}
