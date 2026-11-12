/** Which glyph blocks (GlyphBlocks.tsx) stand for text in a language with no sample sentence. */
import { textStyle } from '@ui/language-style'

/** The block shape for the language `code`: word runs where it spaces its words and is not CJK. */
export function blockShape(code: string): 'square' | 'word' {
  const style = textStyle(code)
  return style.spaces && !style.fullWidth ? 'word' : 'square'
}

/** Word lengths, in characters, for blocks standing in for a short line in the language `code`. */
export function blockWords(code: string): readonly number[] {
  return blockShape(code) === 'word' ? [3, 6, 2, 5] : [3, 2, 2, 3]
}
