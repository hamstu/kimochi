import { forwardRef } from 'react'
import { Check, Plus, Volume2 } from 'lucide-react'
import type { DemoVocab } from '@kimochi/demo-content'

export type AnkiState = 'none' | 'adding' | 'added'

interface WordPopupProps {
  word: string
  entry: DemoVocab
  /** The inflected form seen in the line, when it differs from the dictionary form. */
  surface: string
  /** Gaming Mode moved into the pop-up's buttons (A): the focus is on its first, Add to Anki. */
  focused?: boolean
  /** The + button's state; without `onAnki` it is decoration. */
  anki?: AnkiState
  onAnki?: () => void
}

/** A made-up but steady frequency rank per word, for the badge. */
function rank(word: string): number {
  let h = 7
  for (const c of word) h = (h * 31 + c.charCodeAt(0)) % 9973
  return 300 + (h % 9000)
}

/**
 * A simulated dictionary result, Hachidori-style: the term with its reading over it and its
 * meanings beside it, the deinflection it came from, a frequency badge, the JMdict senses, and the
 * audio and Add to Anki buttons.
 */
export const WordPopup = forwardRef<HTMLDivElement, WordPopupProps>(function WordPopup(
  { word, entry, surface, focused = false, anki = 'none', onAnki },
  ref
) {
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${word}: ${entry.meanings.join('; ')}`}
      className="kd-popup kd-hd overflow-hidden text-left"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="kd-hd-head">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-end gap-x-[0.7em] gap-y-0.5">
            <ruby lang="ja" className="kd-popup-term kd-hd-term font-jp [ruby-position:over]">
              {word}
              <rt className="kd-popup-reading kd-hd-reading">{entry.reading}</rt>
            </ruby>
            <span className="kd-hd-gloss mb-[0.3em]">{entry.meanings.slice(0, 2).join(' · ')}</span>
          </div>
          {surface !== word && (
            <p className="kd-hd-deinflect" lang="ja">
              ▸ {surface} → {word}
            </p>
          )}
          <span className="kd-hd-freq tnum">{rank(word)}</span>
        </div>
        <div className="flex shrink-0 gap-[0.4em] self-center">
          <span className="kd-hd-btn" aria-hidden="true">
            <Volume2 className="size-[1.1em]" />
          </span>
          {onAnki ? (
            <button
              type="button"
              data-anki={anki}
              aria-label={anki === 'added' ? 'In Anki' : 'Add to Anki'}
              title={anki === 'added' ? 'In Anki' : 'Add to Anki'}
              disabled={anki !== 'none'}
              onClick={onAnki}
              className={`kd-hd-btn kd-hd-anki ${anki === 'added' ? 'kd-hd-added' : ''} ${anki === 'adding' ? 'kd-hd-adding' : ''}`}
            >
              {anki === 'added' ? <Check className="size-[1.1em]" /> : <Plus className="size-[1.1em]" />}
            </button>
          ) : (
            <span aria-hidden="true" className={`kd-hd-btn kd-popup-button ${focused ? 'kd-focused' : ''}`}>
              <Plus className="size-[1.1em]" />
            </span>
          )}
        </div>
      </div>
      <div className="kd-hd-dict">
        <div className="kd-hd-dict-name">JMdict</div>
        <ol className="m-0 list-none space-y-[0.25em] p-0">
          {entry.meanings.map((meaning, i) => (
            <li key={i} className="flex items-baseline gap-[0.5em]">
              <span className="kd-hd-num tnum">{i + 1}.</span>
              <span>
                {i === 0 && entry.pos && <span className="kd-hd-pos">{entry.pos}</span>}
                {meaning}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
})
