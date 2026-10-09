/**
 * The demo's view of the shared example game (frontend/dev/demo-content.ts, imported through the
 * `@kimochi/demo-content` alias in vite.config.ts / tsconfig.json). Swap the game there, not here.
 */
import { DEMO_CONTENT, type DemoVocab } from '@kimochi/demo-content'

export const GAME = DEMO_CONTENT

export interface Token {
  text: string
  /** Vocab key, when the demo dictionary has an entry. */
  word: string | null
  /** Punctuation and brackets: not boxed by the overlay. */
  punct: boolean
}

export interface PlayLine {
  text: string
  speaker: string | null
  tokens: Token[]
  /** Index into `tokens` the scripted run opens the popup on (-1: none). */
  focus: number
}

const PUNCT = /^[\s、。！？!?「」『』（）()…・〜ー—\-.,]+$/u

function toToken(raw: string | { text: string; word: string }): Token {
  const text = typeof raw === 'string' ? raw : raw.text
  const key = typeof raw === 'string' ? raw : raw.word
  return { text, word: GAME.vocab[key] ? key : null, punct: PUNCT.test(text) }
}

/** Splits an untokenised line: known vocab words first, then runs of the same script. */
function segment(text: string): Token[] {
  const words = Object.keys(GAME.vocab).sort((a, b) => b.length - a.length)
  const out: Token[] = []
  let i = 0
  while (i < text.length) {
    const hit = words.find((w) => text.startsWith(w, i))
    if (hit) {
      out.push({ text: hit, word: hit, punct: false })
      i += hit.length
      continue
    }
    const kind = (c: string): string =>
      PUNCT.test(c) ? 'p' : /\p{Script=Han}/u.test(c) ? 'k' : /\p{Script=Katakana}/u.test(c) ? 'K' : 'h'
    let j = i + 1
    while (j < text.length && kind(text[j]) === kind(text[i]) && !words.some((w) => text.startsWith(w, j))) j++
    const piece = text.slice(i, j)
    out.push({ text: piece, word: null, punct: kind(text[i]) === 'p' })
    i = j
  }
  return out
}

export const PLAY_LINES: PlayLine[] = GAME.lines
  .filter((line) => line.play)
  .map((line) => {
    const tokens = line.tokens ? line.tokens.map(toToken) : segment(line.text)
    const focusAt = tokens.findIndex((t) => t.word !== null && t.word === line.focus)
    return {
      text: line.text,
      speaker: line.speaker ?? null,
      tokens,
      focus: focusAt >= 0 ? focusAt : tokens.findIndex((t) => t.word !== null)
    }
  })

export function lookup(word: string | null): DemoVocab | null {
  return word ? (GAME.vocab[word] ?? null) : null
}
