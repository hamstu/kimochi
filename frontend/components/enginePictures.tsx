/**
 * The OCR engines' pictures (EngineIcon.tsx draws them): a logo, or a glyph or monogram in the
 * neutral tile. Also handed to pages outside the app as plain data (`ocrPicture`, for the browser
 * extension's model menu), so both show the same pictures.
 */
import type { ReactNode } from 'react'
import { ScanEye, ScanText } from 'lucide-react'
import type { OcrMode } from '../bridge/settings'
import googleLens from '../assets/engine-icons/google-lens.svg'
import kimochiCloud from '../assets/engine-icons/kimochi-cloud.svg'
import windows from '../assets/engine-icons/windows.svg'

/** `tile`: a bare mark drawn inside the neutral tile rather than filling the square itself. */
export type Picture = { src: string; tile?: boolean } | { glyph: ReactNode } | { monogram: string; lang?: string }

/** A paddle, for PaddleOCR: lucide's grid and stroke, so it sits in the tile like `ScanText`. */
const PADDLE = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12.5 11.5 5 19" />
    <path d="m3 17 4 4" />
    <rect x="9.6" y="4.6" width="13.4" height="5.6" rx="2.8" transform="rotate(-45 16.3 7.4)" />
  </svg>
)

export const OCR_PICTURES: Record<OcrMode, Picture> = {
  googlelens: { src: googleLens, tile: true },
  cloud: { src: kimochiCloud },
  meikiocr: { monogram: 'M' },
  mangaocr: { monogram: '漫', lang: 'ja' },
  ppocr: { glyph: PADDLE },
  // Google's library, but not a Google product of its own to show a logo for.
  screenai: { glyph: <ScanEye /> },
  vocr: { monogram: 'V' },
  livetext: { glyph: <ScanText /> },
  oneocr: { src: windows, tile: true }
}

/** An engine's picture as plain data: an image URL, or a tile with a glyph or monogram. */
export type PlainPicture = { src: string; tile: boolean } | { glyph: ReactNode } | { monogram: string; lang?: string }
export const ocrPicture = (mode: OcrMode): PlainPicture => {
  const picture = OCR_PICTURES[mode]
  return 'src' in picture ? { src: picture.src, tile: picture.tile === true } : picture
}
