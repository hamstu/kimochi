/**
 * Text drawn as blocks, for previews of "your text" in a language Kimochi has no sample sentence
 * for (ui/language-samples.ts): neutral rounded shapes the size and rhythm of a word, so the
 * preview shows how a highlight, a hovered card or a selection looks without putting words of
 * another language in front of the reader.
 *
 * The shapes follow the script: a grid of square cells for one set on em squares and unspaced
 * (`square`), and word-shaped runs (a body the height of the letters, a taller stroke here and
 * there, as ascenders are) for one that spaces its words. Sized in em, so they follow the text
 * size they stand in for, in `currentColor`. Hidden from assistive technology: they stand for no
 * words.
 */
import type { ReactNode } from 'react'
import { cn } from '@kit'
import './glyph-blocks.css'

/** Where a word's tall strokes go, by its length: a letter in, and near the end of a long one. */
const TALL = (length: number): number[] => (length < 3 ? [] : length < 5 ? [1] : [1, length - 2])

export function GlyphBlocks({
  length,
  shape,
  className
}: {
  /** The word's length in characters (letters, or cells). */
  length: number
  /** `square`: em cells (CJK and other unspaced scripts); `word`: a spaced word. */
  shape: 'square' | 'word'
  className?: string
}): ReactNode {
  const count = Math.max(1, Math.round(length))
  if (shape === 'square')
    return (
      <span className={cn('k-glyph-blocks', className)} data-shape="square" aria-hidden>
        {Array.from({ length: count }, (_, index) => (
          <i key={index} />
        ))}
      </span>
    )
  const tall = new Set(TALL(count))
  return (
    <span className={cn('k-glyph-blocks', className)} data-shape="word" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <i key={index} data-tall={tall.has(index) ? '' : undefined} />
      ))}
    </span>
  )
}
