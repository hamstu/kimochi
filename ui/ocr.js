/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The OCR backends, behind one call.
 *
 * Every engine runs natively (`ocr_frame`) and returns positioned text. A result
 * without positions (`geometry: false`) is still reported rather than hidden:
 * the overlay publishes the text and renders no boxes instead of looking broken.
 */

import { ocrFrame } from './native.js'
import { normalizeOcrResult } from './ocr-result.js'

/** @typedef {{fullText: string, textAnnotations: unknown[], geometry: boolean}} OcrOutcome */

/**
 * Recognise a captured frame using the configured mode.
 *
 * @returns {Promise<OcrOutcome|null>}
 */
export async function recognize(frame, settings) {
  switch (settings.ocrMode) {
    case 'googlelens':
    case 'mangaocr':
    case 'oneocr':
    case 'livetext':
    case 'meikiocr':
    default: {
      const result = await ocrFrame(
        frame,
        settings.ocrMode === 'local' ? 'meikiocr' : ['googlelens', 'meikiocr', 'mangaocr', 'oneocr', 'livetext'].includes(settings.ocrMode) ? settings.ocrMode : 'cloud'
      )
      const ocr = result?.ocr
      if (!ocr) return null
      return {
        ...normalizeOcrResult(ocr, settings.ocrMode === 'local' ? 'meikiocr' : settings.ocrMode),
        // Preserve frame identity for the caller's freshness and publication guards.
        nativeScanId: result.id ?? null
      }
    }
  }
}
