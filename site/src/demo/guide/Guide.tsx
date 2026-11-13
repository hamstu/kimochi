/**
 * The demo's guide: Mochiko, a visual-novel dialogue box in the lower part of the desk that walks
 * the visitor through Kimochi, one step at a time, from script.json.
 *
 * Script fields (per step):
 *   say      the line, typed in like a visual novel's
 *   face     the portrait: happy, excited, surprised, thinking, wink, sad, proud (public/guide/*.webp)
 *   id       a name to `goto`
 *   point    a ring on what to look at or click (one target, or a list: the first one found);
 *            Kimochi's sidebar scrolls (once per step) to bring a target in its window into view:
 *              { desk: selector }  on the page's desk     { log: selector }  inside Kimochi's window
 *              { word: "focus" }   the word the game's current line suggests looking up
 *            `text` (a regex) narrows a selector to an element whose text, title or label matches.
 *   until    what the visitor has to do before the step moves on (by itself): a fact's name (see
 *            GuideFacts) or { logVisible: selector }, or a list of them (any one will do: list what
 *            later steps wait for too, for a visitor who is ahead), or { logClicked: selector }
 *            (clicked in Kimochi's window since the step began). Without it, a click (or
 *            Space/Enter) moves on.
 *   ahead    { when, goto }: as the step starts, if `when` (an `until`) is already done, go to
 *            `goto` instead (the visitor did it before being asked)
 *   wrong    { when, goto }: while the step shows, if `when` happens, go to `goto` (a correction)
 *   delay    how long the step stays once `until` is done, in ms (default 1200)
 *   choices  buttons: { label, goto?, do?, end? }
 *   do       an action when the step starts (LiveDemo's `onAction`: windowsDesk, download)
 *   if       skip the step unless this fact is true
 *   shift    show the Shift key (lit while the visitor holds it)
 *   keepPopup  leave the game's dictionary pop-up open (it closes as other steps start, unless
 *            the step has `shift` or points at it)
 *   links    "Kimochi supports …" links after the line, in its text: { label, href, icon } (a new
 *            tab); `linksAfter` is said after them
 *   next / end   where to go afterwards, or close the tour
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import script from './script.json'
import { blip } from './blip'
import { getArt, layers, useArt } from './art'

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
type Until = keyof GuideFacts | { logVisible: string } | { logClicked: string }
interface Jump {
  when: Until
  goto: string
}

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
  keepPopup?: boolean
  ahead?: Jump
  wrong?: Jump
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
  /** The game is hooked, with Text hooking on. */
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
  /** The desk is not Windows or Linux, where Text hooking works. */
  notHookPlatform: boolean
  /** The demo is not maximised. */
  notMax: boolean
  /** Show overlay is on. */
  overlay: boolean
  /** The game is the source with its Text hooking switch on (it may still be hooking). */
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
  return {
    x: r.left - d.left + (f?.left ?? 0),
    y: r.top - d.top + (f?.top ?? 0),
    w: r.width,
    h: r.height
  }
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

/** Smoothly scrolls the nearest scrolling box around `el` until all of it shows. */
function reveal(el: Element): void {
  const win = el.ownerDocument.defaultView
  if (!win) return
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = win.getComputedStyle(p).overflowY
    if ((o !== 'auto' && o !== 'scroll') || p.scrollHeight <= p.clientHeight + 1) continue
    const r = el.getBoundingClientRect()
    const b = p.getBoundingClientRect()
    const margin = 12
    let delta = 0
    if (r.top < b.top + margin || r.height > b.height - margin * 2) delta = r.top - b.top - margin
    else if (r.bottom > b.bottom - margin) delta = r.bottom - b.bottom + margin
    if (Math.abs(delta) > 1) p.scrollBy({ top: delta, behavior: 'smooth' })
    return
  }
}

/** The element a `log` point names, whether or not it is scrolled into view. */
function logTarget(point: Point, doc: Document): Element | null {
  if (!point.log) return null
  const all = [...doc.querySelectorAll(point.log)].filter(
    (e) => e.getClientRects().length > 0 && matches(e, point.text)
  )
  return (point.text || all.length < 2 ? all[0] : all[all.length - 1]) ?? null
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
    const all = [...doc.querySelectorAll(point.log)].filter(
      (e) => e.getClientRects().length > 0 && matches(e, point.text) && inView(e)
    )
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
  /** A step starts: whether the game's dictionary pop-up may stay open for it. */
  onPopup?: (keep: boolean) => void
}

export function Guide({
  facts,
  deskRef,
  iframeRef,
  focusToken,
  keys,
  silent,
  onAction,
  onShift,
  onEnd,
  inset = 16,
  shift,
  onPoint,
  onPopup
}: GuideProps) {
  const [index, setIndex] = useState(0)
  // Bumped each time a line starts (also when a step goes back to itself): its text is laid out afresh.
  const [line, setLine] = useState(0)
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
  // When the step began, and what was clicked in Kimochi's window (for `logClicked`).
  const stepAt = useRef(0)
  const clicks = useRef<{ target: Element; at: number }[]>([])
  const listening = useRef(new WeakSet<Document>())

  const factsRef = useRef(facts)
  factsRef.current = facts
  const actionRef = useRef(onAction)
  actionRef.current = onAction

  /** Whether an `until` (or a jump's `when`) is done. */
  const check = useCallback(
    (u: Until | Until[]): boolean => {
      const facts = {
        ...factsRef.current,
        nextLine: factsRef.current.lineSeq > seqAt.current
      }
      const doc = iframeRef.current?.contentDocument
      const one = (c: Until): boolean => {
        if (typeof c === 'string') return !!facts[c]
        if ('logVisible' in c)
          return !!doc && [...doc.querySelectorAll(c.logVisible)].some((e) => e.getClientRects().length > 0)
        return clicks.current.some((k) => k.at >= stepAt.current && !!k.target.closest(c.logClicked))
      }
      return Array.isArray(u) ? u.some(one) : one(u)
    },
    [iframeRef]
  )

  /** The next step to show from `i`, skipping those whose `if` is false or whose `ahead` is done; -1 ends. */
  const resolve = useCallback(
    (i: number): number => {
      let j = i
      for (let hops = 0; j >= 0 && j < STEPS.length && hops < STEPS.length; hops++) {
        const s = STEPS[j]
        if (s.if && !factsRef.current[s.if]) {
          j++
          continue
        }
        if (s.ahead && check(s.ahead.when)) {
          j = indexOf(s.ahead.goto)
          continue
        }
        return j
      }
      return -1
    },
    [check]
  )

  const go = useCallback(
    (target: number): void => {
      const j = resolve(target)
      if (j < 0) return onEnd()
      seqAt.current = factsRef.current.lineSeq
      stepAt.current = performance.now()
      setTyped(0)
      setLine((n) => n + 1)
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

  // A step that is not about the dictionary pop-up starts without one left open.
  const popupRef = useRef(onPopup)
  popupRef.current = onPopup
  useEffect(() => {
    const points = step.point ? (Array.isArray(step.point) ? step.point : [step.point]) : []
    popupRef.current?.(!!step.shift || !!step.keepPopup || points.some((p) => p.desk?.includes('kd-popup')))
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

  // Clicks in Kimochi's window, for `logClicked` (its document is new each time it loads).
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc || listening.current.has(doc)) return
    listening.current.add(doc)
    const note = (event: Event): void => {
      const view = doc.defaultView
      if (!view || !(event.target instanceof view.Element)) return
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return
      clicks.current = [...clicks.current.slice(-19), { target: event.target, at: performance.now() }]
    }
    for (const type of ['pointerup', 'click', 'keydown']) doc.addEventListener(type, note, true)
  }, [tick, iframeRef])

  // Kimochi's sidebar scrolls to what the step points at in its window, once per step.
  const revealed = useRef(-1)
  useEffect(() => {
    if (revealed.current === index || !step.point) return
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    for (const p of Array.isArray(step.point) ? step.point : [step.point]) {
      const el = logTarget(p, doc)
      if (!el) continue
      revealed.current = index
      reveal(el)
      return
    }
  }, [tick, index, step, iframeRef])

  // A correction: the visitor did something else than asked.
  useEffect(() => {
    if (step.wrong && check(step.wrong.when)) go(indexOf(step.wrong.goto))
  }, [tick, step, check, go])

  const waiting = step.until !== undefined
  const met = useMemo(
    () => (step.until ? check(step.until) : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [step, tick, facts, check]
  )

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

  // The box stays at the bottom, and moves to the top only when it would hide a good part of what
  // it points at there and much less of it at the top. A big target (a whole window) shows either way.
  const boxRef = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(false)
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el || !desk) return
    if (!ring) return setTop(false)
    const w = el.offsetWidth
    const h = el.offsetHeight
    const x = (desk.clientWidth - w) / 2
    const r = { x: ring.x - 6, y: ring.y - 6, w: ring.w + 12, h: ring.h + 12 }
    const hidden = (y: number): number =>
      Math.max(0, Math.min(r.x + r.w, x + w) - Math.max(r.x, x)) *
      Math.max(0, Math.min(r.y + r.h, y + h) - Math.max(r.y, y))
    const below = hidden(desk.clientHeight - inset - h)
    const above = hidden(16)
    setTop(ring.h < desk.clientHeight * 0.5 && below > r.w * r.h * 0.15 && above < below / 2)
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

  const chars = useMemo(() => Array.from(step.say), [step])

  // The box grows and shrinks (with a little bounce) to fit each step's line, buttons and all. A
  // callback ref, because the box is made afresh when it shakes (a nudge): the height always
  // follows the one on screen, and a box that is gone (0 high) never sets it.
  const [bodyHeight, setBodyHeight] = useState<number | null>(null)
  const sizer = useRef<ResizeObserver | null>(null)
  const bodyRef = useCallback((el: HTMLDivElement | null): void => {
    sizer.current?.disconnect()
    sizer.current = null
    if (!el) return
    const measure = (): void => {
      if (el.isConnected && el.offsetHeight > 0) setBodyHeight(el.offsetHeight)
    }
    measure()
    sizer.current = new ResizeObserver(measure)
    sizer.current.observe(el)
  }, [])
  useEffect(() => () => sizer.current?.disconnect(), [])

  const face = step.face ?? 'happy'
  const pad = 6
  return (
    <>
      {ring && (
        <div
          aria-hidden="true"
          className="kd-ring pointer-events-none absolute z-[66]"
          style={{
            left: ring.x - pad,
            top: ring.y - pad,
            width: ring.w + pad * 2,
            height: ring.h + pad * 2
          }}
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
          <div
            className="kd-guide-body min-w-0 flex-1"
            style={bodyHeight === null ? undefined : { height: bodyHeight }}
          >
            <div ref={bodyRef} className="py-3.5 pr-4">
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
              {/* The whole line is laid out from the start (no word jumps to the next line as it is
                typed); typing shows each letter where it already is. */}
              <p key={`text-${line}`} className="kd-guide-text" aria-live="polite">
                {chars.map((ch, i) => (
                  <span key={i} className={i < typed ? 'kd-ch kd-ch-on' : 'kd-ch'}>
                    {ch}
                  </span>
                ))}
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
              {step.choices && (
                <div
                  key={`choices-${line}`}
                  className="kd-guide-choices mt-3 flex flex-wrap gap-2"
                  data-shown={done ? '' : undefined}
                >
                  {step.choices.map((c, i) => (
                    <button
                      key={c.label}
                      type="button"
                      className="kd-guide-choice"
                      tabIndex={done ? 0 : -1}
                      aria-hidden={!done}
                      style={{ transitionDelay: done ? `${i * 70}ms` : '0ms' }}
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
          </div>
          {done && !step.choices && (
            <span className="kd-guide-cue" aria-hidden="true">
              {waiting && !met ? (
                <span className="kd-guide-turn">Your turn</span>
              ) : (
                <span className="kd-guide-next">▼</span>
              )}
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
  const art = useArt()
  return (
    <div className="kd-guide-portrait relative shrink-0" aria-hidden="true">
      {broken ? (
        <span className="grid size-full place-items-center text-4xl">🍡</span>
      ) : art.art === 'sutemo' ? (
        // A character from stacked layers (guide/art.ts), the same hop on each change of face.
        <div key={face} className="kd-guide-face relative">
          {layers(art, art.faces[face]).map((src, i) => (
            <img
              key={src}
              src={src}
              alt=""
              draggable={false}
              className={i === 0 ? 'block w-full' : 'absolute inset-0 size-full'}
            />
          ))}
        </div>
      ) : (
        <img
          key={face}
          src={portraitFile(art.art, face)}
          alt=""
          draggable={false}
          onError={() => setBroken(true)}
          className="kd-guide-face"
        />
      )}
    </div>
  )
}

/** The portrait's file: the shipped faces, or the first (AI-made) ones kept in guide/original/. */
const portraitFile = (art: string, face: Face): string =>
  art === 'original' ? `/guide/original/${face}.webp` : CHARACTER.portrait.replace('{face}', face)

const FACES: Face[] = ['happy', 'excited', 'surprised', 'thinking', 'wink', 'sad', 'proud']

/** Fetches every face up front, so a change of expression never flashes. */
export function preloadFaces(): void {
  const art = getArt()
  const srcs =
    art.art === 'sutemo'
      ? [...new Set(FACES.flatMap((f) => layers(art, art.faces[f])))]
      : FACES.map((f) => portraitFile(art.art, f))
  for (const src of srcs) {
    const img = new Image()
    img.src = src
  }
}
