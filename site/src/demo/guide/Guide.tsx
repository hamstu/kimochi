/**
 * The demo's guide: Mochiko, a visual-novel dialogue box in the lower part of the desk that walks
 * the visitor through Kimochi, one step at a time, from script.json.
 *
 * Script fields (per step):
 *   say      the line, typed in like a visual novel's
 *   face     the portrait: happy, excited, surprised, thinking, wink, sad, proud (public/guide/*.webp)
 *   id       a name to `goto`
 *   point    a ring on what to look at or click (one target, or a list: the first one found):
 *              { desk: selector }  on the page's desk     { log: selector }  inside Kimochi's window
 *              { word: "focus" }   the word the game's current line suggests looking up
 *            `text` (a regex) narrows a selector to an element whose text, title or label matches.
 *   until    what the visitor has to do before the step moves on (by itself): a fact's name (see
 *            GuideFacts) or { logVisible: selector }, or a list of them (any one will do: list what
 *            later steps wait for too, for a visitor who is ahead). Without it, a click (or
 *            Space/Enter) moves on.
 *   delay    how long the step stays once `until` is done, in ms (default 1200)
 *   choices  buttons: { label, goto?, do?, end? }
 *   do       an action when the step starts (LiveDemo's `onAction`: windowsDesk, download)
 *   if       skip the step unless this fact is true
 *   shift    show the Shift key (lit while the visitor holds it)
 *   links    "Kimochi supports …" links after the line, in its text: { label, href, icon } (a new
 *            tab); `linksAfter` is said after them
 *   next / end   where to go afterwards, or close the tour
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import script from './script.json'
import { blip } from './blip'

export type Face = 'happy' | 'excited' | 'surprised' | 'thinking' | 'wink' | 'sad' | 'proud'

interface Point {
  desk?: string
  log?: string
  word?: 'focus'
  text?: string
}
interface Choice {
  label: string
  goto?: string
  do?: string
  end?: boolean
}
type Until = keyof GuideFacts | { logVisible: string }

export interface Step {
  id?: string
  face?: Face
  say: string
  point?: Point | Point[]
  until?: Until | Until[]
  delay?: number
  choices?: Choice[]
  do?: string
  if?: keyof GuideFacts
  shift?: boolean
  links?: { label: string; href: string; icon?: string }[]
  /** Said after the links. */
  linksAfter?: string
  next?: string
  end?: boolean
}

/** What the demo tells the guide about the desk, for `until` and `if`. */
export interface GuideFacts {
  kimochiOpen: boolean
  gameOpen: boolean
  /** Kimochi's source is the game (by OCR or hooked). */
  gameSource: boolean
  autoOcr: boolean
  /** The game is hooked by the Text Hooker. */
  hooked: boolean
  /** A line has reached the Log by OCR. */
  lineRead: boolean
  /** A hooked line has reached the Log. */
  hookLine: boolean
  /** A word has been looked up in the game. */
  lookedUp: boolean
  ankiAdded: boolean
  /** Moved on to another line since the step began (a counter; see `nextLine`). */
  lineSeq: number
  nextLine: boolean
  /** The desk is not Windows or Linux, where the Text Hooker works. */
  notHookPlatform: boolean
  /** The demo is not maximised. */
  notMax: boolean
  /** Show overlay is on. */
  overlay: boolean
  /** The visitor chose the game in the Text Hooker (it may still be hooking). */
  hookStarted: boolean
  /** Auto align is on for the hooked game. */
  autoAlign: boolean
}

const STEPS = script.steps as Step[]
const CHARACTER = script.character

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Where `el` is on the desk, offset by the iframe it is in, if any. */
function rectOn(desk: Element, el: Element, frame?: Element): Box {
  const d = desk.getBoundingClientRect()
  const f = frame?.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  return { x: r.left - d.left + (f?.left ?? 0), y: r.top - d.top + (f?.top ?? 0), w: r.width, h: r.height }
}

function matches(el: Element, text?: string): boolean {
  if (!text) return true
  const all = `${el.textContent ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`
  return new RegExp(text, 'i').test(all)
}

const shown = (el: Element): boolean => el.getClientRects().length > 0 && !el.closest('.kd-win-closed')

/** Whether `el` is inside every scrolling box around it, and its window. */
function inView(el: Element): boolean {
  const r = el.getBoundingClientRect()
  const win = el.ownerDocument.defaultView
  if (!win || r.bottom < 0 || r.top > win.innerHeight) return false
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = win.getComputedStyle(p).overflowY
    if (o !== 'auto' && o !== 'scroll' && o !== 'hidden') continue
    const b = p.getBoundingClientRect()
    if (r.bottom <= b.top + 2 || r.top >= b.bottom - 2) return false
  }
  return true
}

function find(point: Point, desk: HTMLElement, iframe: HTMLIFrameElement | null, focus: number | null): Box | null {
  if (point.word === 'focus') {
    if (focus === null || focus < 0) return null
    const el = desk.querySelector(`[data-window="game"] [data-token="${focus}"]`)
    return el && shown(el) ? rectOn(desk, el) : null
  }
  if (point.desk) {
    const el = [...desk.querySelectorAll(point.desk)].find((e) => shown(e) && matches(e, point.text))
    return el ? rectOn(desk, el) : null
  }
  if (point.log) {
    const doc = iframe?.contentDocument
    if (!iframe || !doc || !shown(iframe)) return null
    // Only what can be seen (not scrolled out of its list), the newest (last) first.
    const all = [...doc.querySelectorAll(point.log)].filter((e) => e.getClientRects().length > 0 && matches(e, point.text) && inView(e))
    const el = point.text || all.length < 2 ? all[0] : all[all.length - 1]
    return el ? rectOn(desk, el, iframe) : null
  }
  return null
}

function indexOf(id: string): number {
  return STEPS.findIndex((s) => s.id === id)
}

interface GuideProps {
  facts: GuideFacts
  deskRef: RefObject<HTMLDivElement | null>
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** The token the current line suggests looking up. */
  focusToken: number | null
  /** Keys advance the tour (the stage is hovered, focused or maximised). */
  keys: boolean
  /** No sound: the demo is out of sight. */
  silent: boolean
  onAction: (name: string) => void
  /** The step wants the Shift key shown. */
  onShift: (show: boolean) => void
  onEnd: () => void
  /** Room to leave under the box (a dock). */
  inset?: number
  /** The Shift key, shown in the box while a step wants it. */
  shift?: ReactNode
  /** The ring points into this window: bring it to the front. */
  onPoint?: (where: 'log' | 'game') => void
}

export function Guide({ facts, deskRef, iframeRef, focusToken, keys, silent, onAction, onShift, onEnd, inset = 16, shift, onPoint }: GuideProps) {
  const [index, setIndex] = useState(0)
  const step = STEPS[index]
  const [typed, setTyped] = useState(0)
  const done = typed >= step.say.length
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem('kd-guide-muted') === '1'
    } catch {
      return false
    }
  })
  const [nudge, setNudge] = useState(0)
  const [tick, setTick] = useState(0)
  // The line counter when the step began, for `nextLine`.
  const seqAt = useRef(facts.lineSeq)

  const factsRef = useRef(facts)
  factsRef.current = facts
  const actionRef = useRef(onAction)
  actionRef.current = onAction

  /** The next step to show from `i`, skipping those whose `if` is false; -1 ends. */
  const resolve = useCallback((i: number): number => {
    let j = i
    while (j >= 0 && j < STEPS.length) {
      const cond = STEPS[j].if
      if (!cond || factsRef.current[cond]) return j
      j++
    }
    return -1
  }, [])

  const go = useCallback(
    (target: number): void => {
      const j = resolve(target)
      if (j < 0) return onEnd()
      seqAt.current = factsRef.current.lineSeq
      setTyped(0)
      setIndex(j)
    },
    [resolve, onEnd]
  )

  const forward = useCallback((): void => {
    if (step.end) return onEnd()
    go(step.next ? indexOf(step.next) : index + 1)
  }, [step, index, go, onEnd])

  const forwardRef = useRef(forward)
  forwardRef.current = forward

  // A step's action runs once, as it starts.
  useEffect(() => {
    if (step.do) actionRef.current(step.do)
  }, [step])

  useEffect(() => onShift(!!step.shift), [step, onShift])

  // What the step points into comes to the front, so its target is not under another window.
  const pointRef = useRef(onPoint)
  pointRef.current = onPoint
  useEffect(() => {
    const points = step.point ? (Array.isArray(step.point) ? step.point : [step.point]) : []
    const p = points[0]
    if (!p) return
    if (p.log) pointRef.current?.('log')
    else if (p.word || (p.desk && /data-window=game|kd-popup/.test(p.desk))) pointRef.current?.('game')
  }, [step])

  // The typewriter, with a blip every other letter.
  useEffect(() => {
    if (done) return
    const ch = step.say[typed]
    const pause = /[.!?。！？]/.test(ch) ? 140 : /[,、…]/.test(ch) ? 80 : 22
    const t = setTimeout(() => {
      setTyped((n) => n + 1)
      if (!muted && !silent && typed % 2 === 0 && /\S/.test(ch)) blip()
    }, pause)
    return () => clearTimeout(t)
  }, [typed, done, step, muted, silent])

  // A light clock: re-measures the ring (windows move) and re-checks `until`.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 200)
    return () => clearInterval(t)
  }, [])

  const facts2: GuideFacts = { ...facts, nextLine: facts.lineSeq > seqAt.current }
  const waiting = step.until !== undefined
  const met = useMemo(() => {
    const u = step.until
    if (!u) return false
    const doc = iframeRef.current?.contentDocument
    const one = (c: Until): boolean =>
      typeof c === 'string' ? !!facts2[c] : !!doc && [...doc.querySelectorAll(c.logVisible)].some((e) => e.getClientRects().length > 0)
    return Array.isArray(u) ? u.some(one) : one(u)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, tick, facts])

  // Done what was asked: on to the next step, once the line has been read out.
  useEffect(() => {
    if (!met || !done) return
    // Through a ref: the demo re-renders often (the game plays on), which must not restart the wait.
    const t = setTimeout(() => forwardRef.current(), step.delay ?? 1200)
    return () => clearTimeout(t)
  }, [met, done, step])

  const advance = useCallback((): void => {
    if (!done) return setTyped(step.say.length)
    if (step.choices) return
    if (waiting && !met) return setNudge((n) => n + 1)
    forward()
  }, [done, step, waiting, met, forward])

  const choose = useCallback(
    (c: Choice): void => {
      if (c.do) actionRef.current(c.do)
      if (c.end) return onEnd()
      if (c.goto) return go(indexOf(c.goto))
      if (c.do) return onEnd()
      forward()
    },
    [go, forward, onEnd]
  )

  useEffect(() => {
    if (!keys) return
    const onKey = (event: KeyboardEvent): void => {
      const t = event.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (step.choices && done && /^[1-9]$/.test(event.key)) {
        const c = step.choices[Number(event.key) - 1]
        if (c) {
          event.preventDefault()
          choose(c)
        }
        return
      }
      if (event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowRight') {
        if (t?.tagName === 'BUTTON' && event.key !== 'ArrowRight' && !t.closest('.kd-guide')) return
        event.preventDefault()
        advance()
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [keys, advance, choose, step, done])

  // ---------------------------------------------------------------- the ring
  const desk = deskRef.current
  const ring = useMemo(() => {
    if (!desk || !step.point) return null
    const points = Array.isArray(step.point) ? step.point : [step.point]
    for (const p of points) {
      const box = find(p, desk, iframeRef.current, focusToken)
      if (box) return box
    }
    return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk, step, tick, focusToken])

  // The box moves to the top when what it points at is underneath it.
  const boxRef = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(false)
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el || !desk) return
    if (!ring) return setTop(false)
    const h = el.offsetHeight + inset + 12
    setTop(ring.y + ring.h > desk.clientHeight - h)
  }, [ring, desk, inset])

  const toggleMute = (): void => {
    setMuted((m) => {
      try {
        localStorage.setItem('kd-guide-muted', m ? '0' : '1')
      } catch {
        /* per-visitor nicety only */
      }
      return !m
    })
  }

  const face = step.face ?? 'happy'
  const pad = 6
  return (
    <>
      {ring && (
        <div
          aria-hidden="true"
          className="kd-ring pointer-events-none absolute z-[66]"
          style={{ left: ring.x - pad, top: ring.y - pad, width: ring.w + pad * 2, height: ring.h + pad * 2 }}
        >
          <span className={`kd-ring-arrow ${ring.y < 60 ? 'kd-ring-arrow-below' : ''}`} />
        </div>
      )}
      <div
        ref={boxRef}
        className="kd-guide absolute inset-x-0 z-[68] mx-auto flex w-[min(92%,780px)]"
        style={top ? { top: 16 } : { bottom: inset }}
        role="dialog"
        aria-label={`${CHARACTER.romaji}, your guide`}
      >
        <div
          key={nudge}
          className={`kd-guide-box relative flex w-full cursor-pointer gap-4 text-left ${nudge ? 'kd-guide-nudge' : ''}`}
          onClick={advance}
        >
          <Portrait face={face} />
          <div className="min-w-0 flex-1 py-3.5 pr-4">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="kd-guide-name" lang="ja">
                {CHARACTER.name}
              </span>
              <span className="text-[11px] font-medium tracking-wide text-white/50">{CHARACTER.romaji}</span>
              <span className="ml-auto flex items-center gap-1">
                {shift}
                {waiting && !met && done && (
                  <button type="button" className="kd-guide-skip" onClick={(e) => (e.stopPropagation(), forward())}>
                    Skip
                  </button>
                )}
                <button
                  type="button"
                  aria-label={muted ? 'Turn the voice on' : 'Turn the voice off'}
                  title={muted ? 'Sound on' : 'Sound off'}
                  className="kd-guide-icon"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleMute()
                  }}
                >
                  {muted ? <VolumeX size={14} aria-hidden /> : <Volume2 size={14} aria-hidden />}
                </button>
              </span>
            </div>
            <p className="kd-guide-text" aria-live="polite">
              <span>{step.say.slice(0, typed)}</span>
              <span className="opacity-0" aria-hidden="true">
                {step.say.slice(typed)}
              </span>
              {step.links && (
                <span className={`transition-opacity duration-300 ${done ? 'opacity-100' : 'opacity-0'}`}>
                  {' '}
                  Kimochi supports{' '}
                  {step.links.map((l, i) => (
                    <span key={l.href}>
                      <a
                        href={l.href}
                        target="_blank"
                        rel="noreferrer"
                        tabIndex={done ? 0 : -1}
                        className="kd-guide-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {l.icon && <img src={l.icon} alt="" className="size-3.5 rounded-[3px]" />}
                        {l.label}
                      </a>
                      {i < step.links!.length - 2 ? ', ' : i === step.links!.length - 2 ? ' and ' : '.'}
                    </span>
                  ))}
                  {step.linksAfter && <> {step.linksAfter}</>}
                </span>
              )}
            </p>
            {step.choices && done && (
              <div className="mt-3 flex flex-wrap gap-2">
                {step.choices.map((c, i) => (
                  <button
                    key={c.label}
                    type="button"
                    className="kd-guide-choice"
                    onClick={(e) => {
                      e.stopPropagation()
                      choose(c)
                    }}
                  >
                    <span className="kd-guide-choice-key">{i + 1}</span>
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {done && !step.choices && (
            <span className="kd-guide-cue" aria-hidden="true">
              {waiting && !met ? <span className="kd-guide-turn">Your turn</span> : <span className="kd-guide-next">▼</span>}
            </span>
          )}
        </div>
      </div>
    </>
  )
}

/** The talking head, with a little hop on each change of face. Falls back to a drawn face. */
function Portrait({ face }: { face: Face }) {
  const [broken, setBroken] = useState(false)
  return (
    <div className="kd-guide-portrait relative shrink-0" aria-hidden="true">
      {broken ? (
        <span className="grid size-full place-items-center text-4xl">🍡</span>
      ) : (
        <img
          key={face}
          src={CHARACTER.portrait.replace('{face}', face)}
          alt=""
          draggable={false}
          onError={() => setBroken(true)}
          className="kd-guide-face"
        />
      )}
    </div>
  )
}

/** Fetches every face up front, so a change of expression never flashes. */
export function preloadFaces(): void {
  for (const f of ['happy', 'excited', 'surprised', 'thinking', 'wink', 'sad', 'proud']) {
    const img = new Image()
    img.src = CHARACTER.portrait.replace('{face}', f)
  }
}
