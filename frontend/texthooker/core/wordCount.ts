/**
 * Words in a line, for the Log's reading stats in a language that spaces its words (words/h
 * instead of chars/h): the language's own word segmenter where the runtime has one, else runs of
 * letters and digits between spaces and punctuation. Unspaced languages (Japanese, Chinese, Thai…)
 * keep counting characters, so this is never asked of them.
 */

const segmenters = new Map<string, Intl.Segmenter | null>()

function segmenterFor(code: string): Intl.Segmenter | null {
  let segmenter = segmenters.get(code)
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(code, { granularity: 'word' }) : null
    } catch {
      segmenter = null
    }
    segmenters.set(code, segmenter)
  }
  return segmenter
}

/** How many words `text` has, read as the language `code`. */
export function countWords(text: string, code: string): number {
  const segmenter = segmenterFor(code)
  if (segmenter) {
    let words = 0
    for (const segment of segmenter.segment(text)) if (segment.isWordLike) words += 1
    return words
  }
  return text.match(/[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu)?.length ?? 0
}
