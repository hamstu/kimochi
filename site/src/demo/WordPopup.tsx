import { forwardRef } from 'react'
import type { DemoVocab } from '@kimochi/demo-content'

interface WordPopupProps {
  word: string
  entry: DemoVocab
  /** The inflected form seen in the line, when it differs from the dictionary form. */
  surface: string
  /** Gaming Mode moved into the pop-up's buttons (A): the focus is on its first, Add to Anki. */
  focused?: boolean
}

/** A Yomitan-style result card: term with its reading, part of speech, numbered glosses. */
export const WordPopup = forwardRef<HTMLDivElement, WordPopupProps>(function WordPopup({ word, entry, surface, focused = false }, ref) {
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${word}: ${entry.meanings.join('; ')}`}
      className="kd-popup overflow-hidden rounded-lg border border-hairline bg-raised text-left text-ink shadow-pop"
    >
      <div className="kd-popup-pad">
        <div className="flex items-end justify-between gap-3">
          <ruby lang="ja" className="kd-popup-term font-jp font-semibold leading-tight [ruby-position:over]">
            {word}
            <rt className="kd-popup-reading pb-0.5 font-normal tracking-wide text-ink-2">{entry.reading}</rt>
          </ruby>
          {entry.pos && (
            <span className="mb-1 shrink-0 rounded-sm bg-accent-soft px-1.5 py-px text-[0.85em] font-medium text-accent-ink">{entry.pos}</span>
          )}
        </div>
        {surface !== word && (
          <p className="mt-0.5 text-[0.85em] text-ink-3">
            from <span lang="ja">{surface}</span>
          </p>
        )}
        <ol className="mt-1.5 list-none space-y-0.5 p-0 leading-snug">
          {entry.meanings.map((meaning, i) => (
            <li key={i} className="flex gap-2">
              <span className="tnum w-[0.8em] shrink-0 text-right text-ink-3">{i + 1}</span>
              <span>{meaning}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex items-center justify-between border-t border-hairline bg-bar px-[1.1em] py-[0.35em] text-[0.85em] text-ink-3">
        <span>Demo dictionary</span>
        <span aria-hidden="true" className={`kd-popup-button ${focused ? 'kd-focused' : ''}`}>
          + Anki
        </span>
      </div>
    </div>
  )
})
