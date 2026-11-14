/**
 * What the overlay previews in Settings → Overlay share (OverlayLook.tsx, TextHookerCardSection.tsx):
 * the line they show, in the language being read, and what Blend's preview sits on.
 */
import { useMemo, type ReactNode } from 'react'
import { useLanguage } from '../../bridge/useLanguage'
import { sampleFor } from '@ui/language-samples'
import { textLang } from '@ui/language-style'
import { GlyphBlocks } from '../../components/GlyphBlocks'
import { blockShape, blockWords } from '../../components/glyphBlockShapes'

/** Blend's preview: what the preview's dialogue box is, behind its words. */
export const PREVIEW_SURFACE = { top: '#1b2033', bottom: '#151a2a', ink: 'light' } as const

/**
 * The line the previews read, a word each with one hovered, in the language being read: its sample
 * (ui/language-samples.ts; Japanese's is 今日は いい 天気 ですね, 天気 hovered), or, for a language
 * with none, glyph blocks shaped like its words.
 */
export interface PreviewLine {
  /** Each word's text, or its length in blocks. */
  words: readonly (string | number)[]
  lit: number
  /** Set for a language other than Japanese only: the Japanese preview is as it always was. */
  lang: string | undefined
  shape: 'square' | 'word'
}

export function usePreviewLine(): PreviewLine {
  const [language] = useLanguage()
  return useMemo(() => {
    const sample = sampleFor(language.code)
    const shape = blockShape(language.code)
    const lang = language.code === 'ja' ? undefined : textLang(language.code)
    return sample
      ? { words: sample.preview, lit: sample.lit, lang, shape }
      : { words: blockWords(language.code), lit: 1, lang, shape }
  }, [language.code])
}

/** A preview word: its text, or blocks in its shape. */
export const previewWord = (word: string | number, shape: PreviewLine['shape']): ReactNode =>
  typeof word === 'string' ? word : <GlyphBlocks length={word} shape={shape} />

/** The overlay's lookup key (`overlayLookupKey`) as this platform's keyboards name it, as Shortcuts & Controls does. */
export function lookupKeyName(key: string | undefined, mac: boolean): string {
  if (key === 'ctrl') return mac ? '⌃ Control' : 'Ctrl'
  if (key === 'alt') return mac ? '⌥ Option' : 'Alt'
  if (key === 'meta') return mac ? '⌘ Command' : 'Super'
  return mac ? '⇧ Shift' : 'Shift'
}
