/**
 * The interactive demo on the home page.
 *
 * Desktop platforms: a synthetic visual novel (GameScreen, original CSS/SVG art) in a decorated game
 * window, with Kimochi's overlay drawn over it, beside the REAL Log window: the app's React UI built
 * from the preview harness (vite.demo.config.ts → /demo/panel.html) with the Tauri runtime mocked,
 * embedded in an iframe and driven by postMessage, so each line the game shows arrives in the Log.
 *
 * From `lg` up the desktop is a small desktop of its own, paused (and not interactive) behind a
 * play button. Play starts the guided tour (guide/Guide.tsx, scripted in guide/script.json): Mochiko,
 * in a visual-novel dialogue box, asks the visitor to open Kimochi and the game, choose the game as
 * the source (the real Change source menu, inside the iframe), turn on Auto OCR, look a word up,
 * add it to Anki, and optionally turn on Text hooking for the game (a Windows desk, on other platforms). The game
 * waits on each line for a click, like a visual novel.
 *
 * The windows behave like windows, through a few light shims (frontend/dev/preview-setup.ts):
 * drag them by their title bars (the Log's drag is reported from its iframe), resize them from the
 * corner, click one to bring it to the front, close them (the desktop icons open them again), and
 * Kimochi's mini mode shrinks its window. Positions are fractions of the desk, so maximising the
 * stage to fill the browser (Esc or the button restores it) scales everything with it. The Log is
 * told which windows are open, so its source menu offers only those; it reports its source and
 * switches back, so the game is read only while Kimochi watches it with Auto OCR on, and the overlay
 * shows only with Show overlay on. Narrower screens, and reduced motion, get the two windows stacked, already set up.
 *
 * The platform comes in as a prop: the visitor's OS for the OCR tab, Windows for the Text hooking
 * tab (`input="hook"`: the game's window with its Text hooking switch on, its lines arrive with
 * no scan, and Kimochi's card sits over its text), `deck` for Handheld mode. On the desk, words are
 * looked up as in the app, with Shift held: the scripted session shows the key held (bottom left)
 * for each lookup, and a visitor's own mouse needs it too (a tap does it on a touch screen).
 * Steam Deck: one handheld screen and the controller flow (R4 → radial menu → Scan → D-pad
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
import { Maximize2, Play, RotateCcw, Square, X } from 'lucide-react'
import { useMediaQuery } from '../lib/client'
import { GAME, lookup } from './content'
import { useGuessedPlatform, useOnScreen, useReducedMotion, useResolvedTheme, type Platform } from './env'
import { deckFrames, desktopFrames, hookFrames, usePlayer, type Frame } from './script'
import { GameScreen } from './GameScreen'
import { DeckBody, DeckHud } from './DeckStage'
import { LogFrame, type LogEvent, type PostToLog } from './LogFrame'
import { DesktopBar, Dock, Taskbar, TitleBar, WINDOW_SHAPE, type RunningApp } from './chrome'
import { TryRealThing } from './TryRealThing'
import { PLAY_LINES } from './content'
import { Guide, preloadFaces, type GuideFacts } from './guide/Guide'
import type { AnkiState } from './WordPopup'
import './demo.css'

export interface LiveDemoProps {
  className?: string
  /** The platform to show: the visitor's OS for the Desktop tab, `deck` for Gaming mode. */
  platform?: Platform
  /**
   * How Kimochi reads the game on the desktop: `ocr` (a window, Auto OCR) or `hook` (its window with
   * Text hooking on: the game's own text, no scanning; a Windows desktop).
   */
  input?: 'ocr' | 'hook'
}

const DESKTOP_FRAMES = desktopFrames()
const DECK_FRAMES = deckFrames()
const HOOK_FRAMES = hookFrames()

/** The harness's source ids for the site's own windows (preview-setup.ts). */
const GAME_SOURCE = 'window:101'

type WindowId = 'game' | 'log'
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

/**
 * Where the windows open: Kimochi large on the right (about five-eighths), the game on the left,
 * both above the guide's dialogue box (the lower quarter or so of the desk).
 */
function initialLayout(desk: Size): Layout {
  const floor = desk.height - Math.min(190, desk.height * 0.3)
  // The game large on the left, over Kimochi's left edge (the guide brings forward the window it
  // points into); Kimochi on the right.
  let gw = 0.5
  const room = floor - desk.height * 0.2
  if (gameHeight(gw, desk) > room) gw = ((room - TITLE) * 1.6) / desk.width
  return {
    log: { x: 0.43, y: 0.03, w: 0.545, h: floor / desk.height - 0.05 },
    game: { x: 0.09, y: (floor - gameHeight(gw, desk)) / desk.height - 0.02, w: gw, h: 0 }
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

type Phase = 'idle' | 'running'

/** What Kimochi's window last reported (its `state` event). */
interface LogState {
  sourceId: string | null
  autoOcr: boolean
  overlay: boolean
  input: string
  /** The hook session's phase (attaching, hooked…), or null when not reported. */
  hookPhase: string | null
  /** Auto align for the hooked game. */
  autoAlign: boolean
}

export function LiveDemo({ className = '', platform: chosen, input = 'ocr' }: LiveDemoProps) {
  const detected = useGuessedPlatform()
  // The guide can move the desk to Windows for Text hooking (it works on Windows and Linux).
  const [override, setOverride] = useState<Platform | null>(null)
  const platform = override ?? chosen ?? detected
  const theme = useResolvedTheme()
  const reduced = useReducedMotion()
  const wide = useWide()
  const stageRef = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(stageRef, '0px')
  const near = useOnScreen(stageRef, '600px')
  const [loadLog, setLoadLog] = useState(false)
  useEffect(() => {
    if (near) {
      setLoadLog(true)
      preloadFaces()
    }
  }, [near])

  const deck = platform === 'deck'
  const [max, setMax] = useState(false)
  /** What the visitor reached that only the app can do, offered as a download. */
  const [unavailable, setUnavailable] = useState<string | null>(null)
  // Free windows on a desk: from lg up, or maximised.
  const free = !deck && (wide || max)
  // The guided tour: on the desk, without reduced motion.
  const flow = free && !reduced
  const [phase, setPhase] = useState<Phase>('idle')
  const [run, setRun] = useState(0)
  const [guideOn, setGuideOn] = useState(false)
  const [open, setOpen] = useState<Record<WindowId, boolean>>({ game: false, log: false })
  // Kimochi's Quit, as opposed to its window being hidden or minimised: nothing is read until it is
  // opened again.
  const [quit, setQuit] = useState(false)
  const [logReady, setLogReady] = useState(false)
  const NO_STATE: LogState = {
    sourceId: null,
    autoOcr: false,
    overlay: false,
    input: 'ocr',
    hookPhase: null,
    autoAlign: true
  }
  const [logState, setLogState] = useState<LogState>(NO_STATE)
  // On the guided desk the visitor chooses how Kimochi reads the game, in its source menu.
  const hook = !deck && (flow ? logState.input === 'hook' : input === 'hook')

  // What the visitor has done, for the guide: lines read, words looked up, cards made.
  const [linesIn, setLinesIn] = useState(0)
  const [hookLines, setHookLines] = useState(0)
  const [lineSeq, setLineSeq] = useState(0)
  const [lookups, setLookups] = useState<Record<string, number>>({})
  const [anki, setAnki] = useState<Record<string, AnkiState>>({})
  const [ankiToast, setAnkiToast] = useState<string | null>(null)
  const [shiftWanted, setShiftWanted] = useState(false)
  const [shiftHeld, setShiftHeld] = useState(false)
  const [hover, setHover] = useState(false)

  const resetDesk = (): void => {
    setOpen({ game: false, log: false })
    setQuit(false)
    setOverride(null)
    setLogState(NO_STATE)
    setLinesIn(0)
    setHookLines(0)
    setLookups({})
    setAnki({})
    setAnkiToast(null)
  }

  // A new platform, or a different kind of stage, starts over.
  useEffect(() => {
    setPhase('idle')
    setGuideOn(false)
    resetDesk()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, detected, flow, input])

  const [userCursor, setUserCursor] = useState<number | null>(null)
  const frames = deck ? DECK_FRAMES : hook ? HOOK_FRAMES : DESKTOP_FRAMES
  const postRef = useRef<PostToLog | null>(null)
  // No sound from a demo the visitor cannot see: scrolled away, or another tab.
  useEffect(() => {
    postRef.current?.({ type: 'muted', value: !onScreen })
  }, [onScreen, logReady])
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  /** Kimochi's Log to its newest line, as the app keeps it (in a small window too). */
  const scrollLog = useCallback((): void => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    for (const el of doc.querySelectorAll<HTMLElement>(
      '.log-transcript-frame, .log-transcript, .log-lines, .log-root'
    )) {
      if (el.scrollHeight > el.clientHeight + 2) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }, [])

  const onEnter = useCallback(
    (frame: Frame) => {
      if (frame.emit === 'scan') postRef.current?.({ type: 'scan' })
      if (frame.emit === 'line' || frame.emit === 'hook') setTimeout(scrollLog, 350)
      if (frame.emit === 'line') {
        postRef.current?.({ type: 'line', text: PLAY_LINES[frame.line].text })
        setLinesIn((n) => n + 1)
      }
      if (frame.emit === 'hook') {
        postRef.current?.({ type: 'hook-line', text: PLAY_LINES[frame.line].text })
        setHookLines((n) => n + 1)
      }
    },
    [scrollLog]
  )

  // Kimochi is reading a window: it is running (not quit), and that window is its source with Auto
  // OCR on, or (Text hooking on) hooked. Off the desk the windows are always open.
  const watching = (id: WindowId, source: string, how: 'ocr' | 'hook' = 'ocr'): boolean =>
    (!free || (open[id] && !quit)) &&
    logState.sourceId === source &&
    (how === 'hook'
      ? logState.input === 'hook' && (logState.hookPhase === null || logState.hookPhase === 'hooked')
      : logState.input !== 'hook' && logState.autoOcr)
  const started = deck || phase !== 'idle'
  const reading = deck || (started && watching('game', GAME_SOURCE, hook ? 'hook' : 'ocr'))
  const running = onScreen && !reduced && userCursor === null && reading
  const [playing, nextLine] = usePlayer(frames, running, onEnter, `${platform}:${run}`, flow)
  const frame = reduced ? stillFrame(frames) : playing
  const overlay =
    deck || reduced || ((!free || (open.game && !quit)) && logState.sourceId === GAME_SOURCE && logState.overlay)

  // A visitor's pick belongs to the line it was made on.
  useEffect(() => setUserCursor(null), [frame.line, platform])
  useEffect(() => setLineSeq((n) => n + 1), [frame.line])

  // Each word the visitor opens counts as a lookup (the pop-up's "Looked up N times").
  useEffect(() => {
    if (userCursor === null || !overlay) return
    const word = PLAY_LINES[frame.line].tokens[userCursor]?.word
    if (word) setLookups((l) => ({ ...l, [word]: (l[word] ?? 0) + 1 }))
  }, [userCursor, frame.line, overlay])

  const addToAnki = useCallback((word: string): void => {
    setAnki((a) => ({ ...a, [word]: 'adding' }))
    setTimeout(() => {
      setAnki((a) => ({ ...a, [word]: 'added' }))
      setAnkiToast(word)
      // The new card shows in Kimochi's Anki tab, as in the app.
      postRef.current?.({ type: 'anki-card', term: word, reading: lookup(word)?.reading ?? null })
      // The card is made: the pop-up closes, so the note about it can be read.
      setUserCursor(null)
    }, 650)
  }, [])
  useEffect(() => {
    if (!ankiToast) return
    const t = setTimeout(() => setAnkiToast(null), 5200)
    return () => clearTimeout(t)
  }, [ankiToast])

  // The Shift key the guide shows lights up while the visitor holds it.
  useEffect(() => {
    if (!shiftWanted) return setShiftHeld(false)
    const on = (e: KeyboardEvent): void => setShiftHeld(e.shiftKey)
    const off = (): void => setShiftHeld(false)
    addEventListener('keydown', on)
    addEventListener('keyup', on)
    addEventListener('blur', off)
    return () => {
      removeEventListener('keydown', on)
      removeEventListener('keyup', on)
      removeEventListener('blur', off)
    }
  }, [shiftWanted])

  // ---------------------------------------------------------------- desk and windows
  const deskRef = useRef<HTMLDivElement>(null)
  const [desk, setDesk] = useState<Size | null>(null)
  const [layout, setLayout] = useState<Layout | null>(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const deskSize = useRef(desk)
  deskSize.current = desk
  const [order, setOrder] = useState<WindowId[]>(['log', 'game'])
  // While the page drags or resizes a window, a shield over the Log keeps its iframe from taking
  // the pointer.
  const [busy, setBusy] = useState(false)
  const front = useCallback(
    (id: WindowId): void => setOrder((o) => (o.at(-1) === id ? o : [...o.filter((w) => w !== id), id])),
    []
  )
  const beforeMini = useRef<Placement | null>(null)

  // The taskbar's (and dock's) apps, in the order they were opened.
  const [launched, setLaunched] = useState<WindowId[]>([])
  useEffect(() => {
    setLaunched((l) => {
      const ids: WindowId[] = ['game', 'log']
      const kept = l.filter((id) => open[id])
      const added = ids.filter((id) => open[id] && !kept.includes(id))
      return [...kept, ...added]
    })
  }, [open])
  const frontmost = order.filter((id) => open[id]).at(-1)
  const apps: RunningApp[] = launched.map((id) => ({
    id,
    label: id === 'game' ? GAME.app : 'Kimochi',
    icon: id === 'game' ? <GameIcon size="sm" /> : <img src="/icon.svg" alt="" className="size-4.5" />,
    active: id === frontmost
  }))

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
  }, [hasDesk, run])

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
  const onLogEvent = (event: LogEvent): void => {
    if (event.type === 'state') {
      setLogState({
        sourceId: event.sourceId,
        autoOcr: event.autoOcr,
        overlay: event.overlay,
        input: event.input ?? 'ocr',
        hookPhase: event.hookPhase ?? null,
        autoAlign: event.autoAlign ?? true
      })
    } else if (event.type === 'unavailable') {
      setUnavailable(event.feature)
    } else if (event.type === 'interact') {
      front('log')
    } else if (event.type === 'activate') {
      if (event.sourceId === GAME_SOURCE) front('game')
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
        {
          ...start.place,
          x: start.place.x + (event.x - start.x) / d.width,
          y: start.place.y + (event.y - start.y) / d.height
        },
        d
      )
      setLayout((l) => (l ? { ...l, log: next } : l))
    }
  }

  // The Log offers only the site's windows that are open.
  const openSources = open.game ? GAME_SOURCE : ''
  useEffect(() => {
    if (!free || !logReady) return
    postRef.current?.({ type: 'sources', open: openSources ? openSources.split(',') : [] })
  }, [free, logReady, openSources])

  // ---------------------------------------------------------------- the guided tour
  // On the guided desk the game's own lookups are the visitor's: the script never opens one.
  const shownFrame: Frame = flow ? { ...frame, cursor: null, popup: false } : frame

  const play = (): void => {
    setUserCursor(null)
    if (!flow) return setPhase('running')
    resetDesk()
    setLayout(null)
    setLogReady(false)
    setRun((r) => r + 1)
    setPhase('running')
    setGuideOn(true)
  }
  const stop = (): void => {
    resetDesk()
    setLayout(null)
    setLogReady(false)
    setRun((r) => r + 1)
    setGuideOn(false)
    setPhase('idle')
  }

  // Out of the maximised demo first, once the page can scroll again.
  const toDownload = (): void => {
    setUnavailable(null)
    setMax(false)
    setTimeout(
      () => document.getElementById('get-kimochi')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      50
    )
  }

  const onAction = (name: string): void => {
    if (name === 'maximise') setMax(true)
    // Download leaves the demo for the page's download button.
    if (name === 'download') {
      stop()
      toDownload()
    }
    if (name === 'windowsDesk') {
      // A Windows PC for Text hooking: Kimochi's window loads again, as on that PC, with both
      // windows open.
      setOverride('windows')
      setLogReady(false)
      setLogState(NO_STATE)
      setOpen((o) => ({ ...o, game: true, log: true }))
      setQuit(false)
    }
  }

  const facts: GuideFacts = {
    kimochiOpen: open.log && !quit,
    gameOpen: open.game,
    gameSource: logState.sourceId === GAME_SOURCE,
    autoOcr: logState.autoOcr,
    hookStarted: logState.sourceId === GAME_SOURCE && logState.input === 'hook',
    hooked: logState.sourceId === GAME_SOURCE && logState.input === 'hook' && logState.hookPhase === 'hooked',
    autoAlign: logState.autoAlign,
    overlay: logState.overlay,
    notMax: !max,
    lineRead: linesIn > 0,
    hookLine: hookLines > 0,
    lookedUp: Object.keys(lookups).length > 0,
    ankiAdded: Object.values(anki).includes('added'),
    lineSeq,
    nextLine: false,
    notHookPlatform: platform !== 'windows' && platform !== 'linux'
  }
  const focusToken = PLAY_LINES[frame.line]?.focus ?? null
  // A click on the game closes its pop-up and moves its text on.
  const advanceGame = useCallback((): void => {
    setUserCursor(null)
    nextLine()
  }, [nextLine])

  const screen = useMemo(
    () => (
      <GameScreen
        frame={shownFrame}
        variant={deck ? 'deck' : 'desktop'}
        paused={!onScreen}
        userCursor={userCursor}
        onUserCursor={setUserCursor}
        overlay={overlay}
        hook={hook}
        aligned={!hook || !flow || logState.autoAlign}
        anki={flow ? anki : undefined}
        onAnki={flow ? addToAnki : undefined}
        onAdvance={flow ? advanceGame : undefined}
        sticky={flow}
      >
        {deck && <DeckHud frame={frame} />}
      </GameScreen>
    ),
    [
      frame,
      shownFrame,
      deck,
      onScreen,
      userCursor,
      overlay,
      hook,
      flow,
      logState.autoAlign,
      anki,
      addToAnki,
      advanceGame
    ]
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
  // `demo` only tells the tabs apart, so switching between them loads the Log afresh.
  const logParams: Record<string, string> = flow
    ? // Show overlay starts off for the visitor to turn on; on the Text hooking Windows desk they
      // already have.
      { nosource: '1', auto: '0', overlay: override ? '1' : '0', sidebar: '1', lines: '0', demo: input }
    : { sidebar: free ? '1' : '0', demo: input, ...(hook ? { input: 'hook' } : {}) }
  const showPlay = !deck && !reduced && phase === 'idle'
  // Before Play, the desk is a picture: nothing on it can be clicked or focused.
  const idle = flow && phase === 'idle'
  const inert = idle || undefined
  const tour = flow && phase === 'running'

  return (
    <div className={`w-full ${className}`}>
      <div
        ref={stageRef}
        role={max ? 'dialog' : undefined}
        aria-modal={max || undefined}
        aria-label={max ? 'Kimochi demo, maximised' : undefined}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        className={
          max
            ? 'kd-stage fixed inset-0 z-[70] flex flex-col overflow-hidden'
            : 'kd-stage relative flex w-full [overflow-anchor:none] flex-col overflow-hidden rounded-xl border border-hairline lg:aspect-[16/10]'
        }
      >
        <div
          className={`absolute right-0 z-[80] flex items-center gap-1 ${max ? 'top-[env(safe-area-inset-top)] p-2' : 'top-0 p-0.5'}`}
        >
          {tour && (
            <>
              <button
                type="button"
                onClick={play}
                aria-label="Start the demo again"
                title="Start again"
                className={`kd-max grid place-items-center ${max ? 'size-11 rounded-full md:size-9' : 'size-5 rounded-md'}`}
              >
                <RotateCcw size={max ? 16 : 12} aria-hidden />
              </button>
              <button
                type="button"
                onClick={stop}
                aria-label="Stop the demo"
                title="Stop"
                className={`kd-max grid place-items-center ${max ? 'size-11 rounded-full md:size-9' : 'size-5 rounded-md'}`}
              >
                <Square size={max ? 14 : 10} aria-hidden fill="currentColor" />
              </button>
            </>
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
            <DesktopBar platform={platform} replay={tour} />
            <div
              ref={deskRef}
              className={free ? 'relative min-h-[560px] flex-1' : 'relative grid min-h-0 flex-1 gap-4 p-3 sm:p-5'}
            >
              {free && (
                <>
                  <div className="absolute top-4 left-5 flex flex-col gap-4" inert={inert}>
                    <DesktopIcon
                      id="kimochi"
                      label="Kimochi"
                      icon={<img src="/icon.svg" alt="" className="size-10" />}
                      onOpen={() => openWindow('log')}
                    />
                    <DesktopIcon id="game" label={GAME.app} icon={<GameIcon />} onOpen={() => openWindow('game')} />
                  </div>
                </>
              )}
              <div
                data-window="game"
                inert={inert}
                className={`min-w-0 overflow-hidden ${WINDOW_SHAPE[platform]} ${shown('game') ? 'kd-win-open' : 'kd-win-closed'} ${flow ? 'kd-vn' : ''}`}
                style={placed('game')}
                onPointerDown={free ? () => front('game') : undefined}
              >
                <div onPointerDown={free ? track('game', 'move') : undefined}>
                  <TitleBar
                    platform={platform}
                    title={GAME.app}
                    icon={<GameIcon size="xs" />}
                    onClose={close('game')}
                  />
                </div>
                <div className="relative">
                  {screen}
                  {ankiToast && <AnkiToast word={ankiToast} />}
                </div>
                {corner('game')}
              </div>
              <div
                data-window="log"
                inert={inert}
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
              {tour && guideOn && (
                <Guide
                  key={run}
                  facts={facts}
                  deskRef={deskRef}
                  iframeRef={iframeRef}
                  focusToken={focusToken}
                  keys={hover || max}
                  silent={!onScreen}
                  onAction={onAction}
                  onShift={setShiftWanted}
                  shift={shiftWanted ? <ShiftKey down={shiftHeld} /> : null}
                  onPoint={(where) => {
                    front(where)
                    if (where === 'log') setTimeout(scrollLog, 100)
                  }}
                  onPopup={(keep) => {
                    if (!keep) setUserCursor(null)
                  }}
                  inset={platform === 'macos' ? 64 : 16}
                  onEnd={() => {
                    setGuideOn(false)
                    setShiftWanted(false)
                  }}
                />
              )}
              {free && platform === 'macos' && <Dock apps={apps} />}
              {showPlay && (
                <button
                  type="button"
                  onClick={play}
                  disabled={flow && loadLog && !logReady}
                  aria-label="Play the demo"
                  className="kd-play absolute top-1/2 left-1/2 z-[70] grid size-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
                >
                  <Play size={30} aria-hidden className="translate-x-0.5" fill="currentColor" />
                </button>
              )}
            </div>
            {platform === 'windows' && <Taskbar apps={free ? apps : []} />}
          </>
        )}
        {unavailable && !deck && (
          <TryRealThing
            platform={platform}
            feature={unavailable}
            onTry={toDownload}
            onClose={() => setUnavailable(null)}
          />
        )}
      </div>
    </div>
  )
}

/** The demo game's icon: a pastel tile with a cute emoji in it. */
function GameIcon({ size = 'md' }: { size?: 'xs' | 'sm' | 'md' }) {
  const box =
    size === 'xs'
      ? 'size-3.5 rounded-[3px] text-[9px]'
      : size === 'sm'
        ? 'size-4.5 rounded-[4px] text-[11px]'
        : 'size-10 rounded-[10px] text-[22px]'
  return (
    <span className={`kd-game-icon grid place-items-center leading-none ${box}`} aria-hidden="true">
      🌸
    </span>
  )
}

/** "Added to Anki": what Kimochi put on the card, in the game's corner for a few seconds. */
function AnkiToast({ word }: { word: string }) {
  return (
    <div className="kd-anki-toast absolute top-3 right-3 z-[8]" role="status">
      <div className="flex items-center gap-2 font-semibold">
        <span className="grid size-5 place-items-center rounded-full bg-[#3fb950] text-[11px] text-white">✓</span>
        Added to Anki
        <span className="font-jp font-normal text-white/70" lang="ja">
          {word}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {['Sentence', 'Sentence audio', 'Screenshot', 'Reading', 'Meaning'].map((f) => (
          <span key={f} className="kd-anki-field">
            {f}
          </span>
        ))}
      </div>
    </div>
  )
}

/** A desktop icon: picture over a label; a double-click opens it. */
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
      <span
        className="max-w-full truncate px-1 text-[11px] font-medium"
        lang={/[^\x20-\x7e]/.test(label) ? 'ja' : undefined}
      >
        {label}
      </span>
    </button>
  )
}

/**
 * The Shift key, bottom left, while the guide asks for a lookup: the app looks words up while Shift
 * is held over them, and the key lights up while the visitor holds it.
 */
function ShiftKey({ down }: { down: boolean }) {
  return (
    <div aria-hidden="true" className={`kd-shift kd-shift-sm pointer-events-none ${down ? 'kd-shift-down' : ''}`}>
      <span className="kd-shift-cap">
        <svg
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        >
          <path d="M9 18v-6H5l7-7 7 7h-4v6H9z" />
        </svg>
        Shift
      </span>
      <span className="kd-shift-label">Held to look up</span>
    </div>
  )
}
