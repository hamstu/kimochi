import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import './word-flipper.css'

/**
 * The hero headline's changing words: "<verb> in <language>", all on one line. Each word sits in
 * a small box; when it changes, its characters slide up out of the box one after another and the
 * next word's slide in from below, while the box eases to the new word's width, so the whole line
 * (the fixed "in" with it) glides to stay centred.
 *
 * - The verb and the language take turns (useFlipClock): the verb changes, then the language,
 *   then the verb, so only one word moves at a time.
 * - The languages are the first 20 of the app's language list (`ui/languages.ts`, ordered by how
 *   many people learn each), each in its own language, in a mixed order so neighbouring words use
 *   different scripts. Left to right only, as the app is.
 * - Server-rendered with the first words ("Read", 日本語) and no animation; the clock starts in an
 *   effect, so hydration matches. The boxes are `aria-hidden`: the headline's accessible text is
 *   static (Hero renders it for screen readers).
 * - Never changes the line's height: the characters are drawn at `line-height: 0` inside a box
 *   whose own line is the headline font's, so a tall script (Thai, Devanagari) cannot grow it.
 * - The clock pauses while the pointer is over the headline, off screen and in hidden tabs. Under
 *   `prefers-reduced-motion` the words cross-fade whole and the width snaps (word-flipper.css).
 */

type Script = 'Jpan' | 'Kore' | 'Hans' | 'Hant' | 'Latn' | 'Cyrl' | 'Deva' | 'Thai'

export interface FlipWord {
  /** BCP 47, for `lang` (fonts and glyph variants). */
  code: string
  word: string
  script: Script
}

/** What Kimochi helps you do, in turn. */
export const VERBS: readonly FlipWord[] = [
  { code: 'en', word: 'Read', script: 'Latn' },
  { code: 'en', word: 'Play', script: 'Latn' },
  { code: 'en', word: 'Learn', script: 'Latn' }
]

/** The order shown, starting with Japanese, Kimochi's first language. */
export const LANGUAGES: readonly FlipWord[] = [
  { code: 'ja', word: '日本語', script: 'Jpan' },
  { code: 'fr', word: 'Français', script: 'Latn' },
  { code: 'es', word: 'Español', script: 'Latn' },
  { code: 'ko', word: '한국어', script: 'Kore' },
  { code: 'de', word: 'Deutsch', script: 'Latn' },
  { code: 'zh-Hans', word: '简体中文', script: 'Hans' },
  { code: 'it', word: 'Italiano', script: 'Latn' },
  { code: 'ru', word: 'Русский', script: 'Cyrl' },
  { code: 'pt', word: 'Português', script: 'Latn' },
  { code: 'hi', word: 'हिन्दी', script: 'Deva' },
  { code: 'en', word: 'English', script: 'Latn' },
  { code: 'th', word: 'ไทย', script: 'Thai' },
  { code: 'vi', word: 'Tiếng Việt', script: 'Latn' },
  { code: 'zh-Hant', word: '繁體中文', script: 'Hant' },
  { code: 'id', word: 'Bahasa Indonesia', script: 'Latn' },
  { code: 'tr', word: 'Türkçe', script: 'Latn' },
  { code: 'yue', word: '粵語', script: 'Hant' },
  { code: 'pl', word: 'Polski', script: 'Latn' },
  { code: 'nl', word: 'Nederlands', script: 'Latn' },
  { code: 'sv', word: 'Svenska', script: 'Latn' }
]

/** From one word changing to the next (the verb and the language alternate, so each stays twice as long). */
const STEP_MS = 1700
/** Per-character delay; keep in step with the stagger in word-flipper.css. */
const STAGGER_MS = 24
const OUT_MS = 280

/**
 * The flip count: one more every STEP_MS while `ref` is on screen, the tab is shown and nothing
 * pauses it. Step `n` shows verb `ceil(n / 2)` and language `floor(n / 2)`: odd steps change the
 * verb, even ones the language.
 */
export function useFlipClock(ref: RefObject<HTMLElement | null>, paused: boolean): number {
  const [step, setStep] = useState(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let visible = true
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
    io.observe(el)
    const timer = window.setInterval(() => {
      if (visible && !document.hidden && !pausedRef.current) setStep((s) => s + 1)
    }, STEP_MS)
    return () => {
      window.clearInterval(timer)
      io.disconnect()
    }
  }, [ref])
  return step
}

/**
 * The pieces that move one by one: grapheme clusters, so accents and Thai marks stay on their
 * letters. Devanagari moves as one piece, since splitting it would break its conjuncts (न्द).
 * Spaces become no-break spaces, which keep their width inside an inline-block.
 */
function pieces({ word, script }: FlipWord): string[] {
  if (script === 'Deva') return [word]
  const parts =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(word), (s) => s.segment)
      : Array.from(word)
  return parts.map((p) => (p === ' ' ? ' ' : p))
}

function Word({ word, state }: { word: FlipWord; state: 'still' | 'in' | 'out' }) {
  return (
    <span className={`lf-word lf-${state}`} data-lang={word.code} data-script={word.script}>
      {pieces(word).map((p, i) => (
        <span key={i} className="lf-char" lang={word.code} style={{ '--i': i } as CSSProperties}>
          {p}
        </span>
      ))}
    </span>
  )
}

/** One changing word in its box, showing `words[index % words.length]`. */
export function WordFlipper({ words, index }: { words: readonly FlipWord[]; index: number }) {
  const current = index % words.length
  const boxRef = useRef<HTMLSpanElement>(null)
  const [{ shown, prev, moved }, setState] = useState({ shown: current, prev: -1, moved: false })

  // A new word: the old one stays a moment, sliding out, while the new one slides in.
  if (current !== shown) setState({ shown: current, prev: shown, moved: true })

  // The box's width: from the old word's to the new one's (FLIP), then back to auto, so it keeps
  // following the fluid headline size when the window is resized. The old width is the outgoing
  // word's (still laid out, though positioned out of the flow) plus the box's padding.
  useLayoutEffect(() => {
    const box = boxRef.current
    const incoming = box?.querySelector<HTMLElement>('.lf-in')
    const outgoing = box?.querySelector<HTMLElement>('.lf-out')
    if (!box || !incoming || !outgoing) return
    box.style.transition = 'none'
    box.style.width = ''
    const to = box.getBoundingClientRect().width
    const padding = to - incoming.getBoundingClientRect().width
    box.style.width = `${outgoing.getBoundingClientRect().width + padding}px`
    void box.offsetWidth
    box.style.transition = ''
    box.style.width = `${to}px`
    const clear = window.setTimeout(() => {
      box.style.width = ''
    }, 700)
    return () => window.clearTimeout(clear)
  }, [shown])

  // Drop the outgoing word once its last character is gone.
  useEffect(() => {
    if (prev < 0) return
    const t = window.setTimeout(
      () => setState((s) => (s.prev === prev ? { ...s, prev: -1 } : s)),
      OUT_MS + pieces(words[prev]).length * STAGGER_MS + 50
    )
    return () => window.clearTimeout(t)
  }, [prev, words])

  return (
    <span ref={boxRef} className="lf-box" aria-hidden="true">
      <Word key={shown} word={words[shown]} state={moved ? 'in' : 'still'} />
      {prev >= 0 && <Word key={`out-${prev}`} word={words[prev]} state="out" />}
    </span>
  )
}
