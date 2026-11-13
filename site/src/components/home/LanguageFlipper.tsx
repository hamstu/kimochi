import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import './language-flipper.css'

/**
 * The hero headline's changing word: the name of a language, in that language, in a small box.
 * Every couple of seconds its characters slide up out of the box one after another and the next
 * language's slide in from below, while the box eases to the new word's width (so the line
 * re-centres smoothly and nothing below it moves).
 *
 * - The words are the first 20 of the app's language list (`ui/languages.ts`, ordered by how many
 *   people learn each), in a mixed order so neighbouring words use different scripts. Left to
 *   right only, as the app is.
 * - Server-rendered with the first word (日本語) and no animation; the timer starts in an effect,
 *   so hydration matches. The box is `aria-hidden`: the headline's accessible text is static
 *   (Hero renders "any language" for screen readers).
 * - Never changes the line's height: the characters are drawn at `line-height: 0` inside a box
 *   whose own line is the headline font's, so a tall script (Thai, Devanagari) cannot grow it.
 * - Pauses while the pointer is over the headline, off screen and in hidden tabs. Under
 *   `prefers-reduced-motion` the words cross-fade whole and the width snaps (language-flipper.css).
 */

type Script = 'Jpan' | 'Kore' | 'Hans' | 'Hant' | 'Latn' | 'Cyrl' | 'Deva' | 'Thai'

interface FlipWord {
  /** BCP 47, for `lang` (fonts and glyph variants). */
  code: string
  word: string
  script: Script
}

/** The order shown, starting with Japanese, Kimochi's first language. */
export const FLIP_WORDS: readonly FlipWord[] = [
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

/** How long a word stays, from the start of one flip to the next. */
const DWELL_MS = 2400
/** Per-character delay; keep in step with the stagger in language-flipper.css. */
const STAGGER_MS = 24
const OUT_MS = 280

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

const PIECES = FLIP_WORDS.map(pieces)

function Word({ index, state }: { index: number; state: 'still' | 'in' | 'out' }) {
  const w = FLIP_WORDS[index]
  return (
    <span className={`lf-word lf-${state}`} data-lang={w.code} data-script={w.script}>
      {PIECES[index].map((p, i) => (
        <span key={i} className="lf-char" lang={w.code} style={{ '--i': i } as CSSProperties}>
          {p}
        </span>
      ))}
    </span>
  )
}

export function LanguageFlipper({ paused = false }: { paused?: boolean }) {
  const [{ index, prev, moved }, setState] = useState({ index: 0, prev: -1, moved: false })
  const boxRef = useRef<HTMLSpanElement>(null)
  const fromWidth = useRef(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  // The clock: one flip every DWELL_MS while visible, not paused and the tab is shown.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    let visible = true
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
    io.observe(box)
    const timer = window.setInterval(() => {
      if (!visible || document.hidden || pausedRef.current) return
      fromWidth.current = box.getBoundingClientRect().width
      setState((s) => ({ index: (s.index + 1) % FLIP_WORDS.length, prev: s.index, moved: true }))
    }, DWELL_MS)
    return () => {
      window.clearInterval(timer)
      io.disconnect()
    }
  }, [])

  // The box's width: from the old word's to the new one's (FLIP), then back to auto, so it keeps
  // following the fluid headline size when the window is resized.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || !moved) return
    box.style.transition = 'none'
    box.style.width = ''
    const to = box.getBoundingClientRect().width
    box.style.width = `${fromWidth.current}px`
    void box.offsetWidth
    box.style.transition = ''
    box.style.width = `${to}px`
    const clear = window.setTimeout(() => {
      box.style.width = ''
    }, 700)
    return () => window.clearTimeout(clear)
  }, [index, moved])

  // Drop the outgoing word once its last character is gone.
  useEffect(() => {
    if (prev < 0) return
    const t = window.setTimeout(
      () => setState((s) => (s.prev === prev ? { ...s, prev: -1 } : s)),
      OUT_MS + PIECES[prev].length * STAGGER_MS + 50
    )
    return () => window.clearTimeout(t)
  }, [prev])

  return (
    <span ref={boxRef} className="lf-box" aria-hidden="true">
      <Word key={index} index={index} state={moved ? 'in' : 'still'} />
      {prev >= 0 && <Word key={`out-${prev}`} index={prev} state="out" />}
    </span>
  )
}
