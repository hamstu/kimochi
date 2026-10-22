import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import type { DemoVocab } from '@kimochi/demo-content'
import { WordPopup } from './WordPopup'

/** The Easter egg's message, as read into the Log (one line). */
export const EGG_LINE = '遊んでくれて、ありがとう！本物のKimochiで、好きなゲームを日本語で読もう。'

/** Every word of the message, with its dictionary form; punctuation is `null`. */
const LINES: [string, string | null][][] = [
  [
    ['遊んで', '遊ぶ'],
    ['くれて', 'くれる'],
    ['、', null],
    ['ありがとう', 'ありがとう'],
    ['！', null]
  ],
  [
    ['本物', '本物'],
    ['の', 'の'],
    ['Kimochi', 'Kimochi'],
    ['で', 'で'],
    ['、', null],
    ['好き', '好き'],
    ['な', 'な'],
    ['ゲーム', 'ゲーム'],
    ['を', 'を'],
    ['日本語', '日本語'],
    ['で', 'で'],
    ['読もう', '読む'],
    ['。', null]
  ]
]

/** A small demo dictionary for the message, in the shape of the game's (demo-content.ts). */
const VOCAB: Record<string, DemoVocab> = {
  遊ぶ: { reading: 'あそぶ', pos: 'Verb', meanings: ['to play', 'to have fun'] },
  くれる: { reading: 'くれる', pos: 'Verb', meanings: ['to do (something) for me', 'to give (to me)'] },
  ありがとう: { reading: 'ありがとう', pos: 'Expression', meanings: ['thank you', 'thanks'] },
  本物: { reading: 'ほんもの', pos: 'Noun', meanings: ['the real thing', 'genuine article'] },
  の: { reading: 'の', pos: 'Particle', meanings: ['of; belonging to', 'links one noun to another'] },
  Kimochi: { reading: 'きもち', pos: 'Name', meanings: ['this app (気持ち: feeling, mood)'] },
  で: { reading: 'で', pos: 'Particle', meanings: ['with; by means of', 'in; at'] },
  好き: { reading: 'すき', pos: 'Adjective', meanings: ['liked; favourite', 'fond of'] },
  な: { reading: 'な', pos: 'Particle', meanings: ['links an adjective to a noun'] },
  ゲーム: { reading: 'げーむ', pos: 'Noun', meanings: ['game', 'video game'] },
  を: { reading: 'を', pos: 'Particle', meanings: ['marks the object of a verb'] },
  日本語: { reading: 'にほんご', pos: 'Noun', meanings: ['the Japanese language'] },
  読む: { reading: 'よむ', pos: 'Verb', meanings: ['to read', '(読もう) let’s read'] }
}

/**
 * The Easter egg's app: a thank-you in Japanese and a way back to Download. Once Kimochi has read
 * it (`boxes`), its words get the overlay's boxes and hovering one opens its card, as on the game.
 */
export function EggApp({ boxes, onDownload }: { boxes: boolean; onDownload: () => void }) {
  const [hover, setHover] = useState<string | null>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const words = useRef(new Map<string, HTMLSpanElement | null>())
  const shown = boxes ? hover : null
  const [line, index] = shown ? shown.split(':').map(Number) : [-1, -1]
  const token = shown ? LINES[line][index] : null
  const entry = token?.[1] ? VOCAB[token[1]] : null

  // Above the word, kept inside the window; below it when there is no room.
  useLayoutEffect(() => {
    const area = areaRef.current
    const el = popupRef.current
    const anchor = shown ? words.current.get(shown) : null
    if (!area || !el || !anchor) return
    const a = area.getBoundingClientRect()
    const w = anchor.getBoundingClientRect()
    const left = Math.min(Math.max(6, w.left - a.left + w.width / 2 - el.offsetWidth / 2), a.width - el.offsetWidth - 6)
    let top = w.top - a.top - el.offsetHeight - 8
    if (top < 6) top = w.bottom - a.top + 8
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [shown])

  let n = 0
  return (
    <div ref={areaRef} className="kd-egg relative flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
      <div className={boxes ? 'kd-boxes' : ''}>
        {LINES.map((tokens, l) => (
          <p
            key={l}
            lang="ja"
            className={l === 0 ? 'text-[1.5rem] leading-snug font-semibold text-ink' : 'mt-4 text-[0.95rem] leading-relaxed text-ink-2'}
          >
            {tokens.map(([text, word], i) => {
              if (!word) return <span key={i}>{text}</span>
              const key = `${l}:${i}`
              return (
                <span
                  key={key}
                  ref={(el) => {
                    words.current.set(key, el)
                  }}
                  className={`kd-word kd-known ${shown === key ? 'kd-current kd-selected' : ''}`}
                  style={{ ['--w' as string]: n++ }}
                  onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(key)}
                  onPointerLeave={(e) => e.pointerType === 'mouse' && setHover((h) => (h === key ? null : h))}
                  onClick={() => setHover((h) => (h === key ? null : key))}
                >
                  {text}
                </span>
              )
            })}
          </p>
        ))}
      </div>
      <button type="button" onClick={onDownload} lang="ja" className="kd-egg-go inline-flex items-center gap-2 rounded-lg px-4 py-2 text-small font-semibold">
        ダウンロードへ
        <ArrowUp size={14} aria-hidden />
      </button>
      {entry && token && (
        <WordPopup key={shown} ref={popupRef} word={token[1]!} entry={entry} surface={token[0]} />
      )}
    </div>
  )
}
