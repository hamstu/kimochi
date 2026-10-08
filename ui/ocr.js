/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The OCR backends, behind one call.
 *
 * Electron exposed the same three on its preload bridge (perform-google-ocr,
 * perform-ocr, perform-ow-ocr). Cloud and MeikiOCR return bounding boxes;
 * OwOCR returns plain text. That asymmetry is preserved and
 * reported rather than hidden — `geometry: false` tells the overlay there is
 * nothing to position, so it publishes the text to history, the texthooker and
 * TTS and renders no boxes, instead of looking broken.
 */

import { ocrFrame } from './native.js'
import { frameBlob } from './frames.js'
import { normalizeOcrResult } from './ocr-result.js'

/** @typedef {{fullText: string, textAnnotations: unknown[], geometry: boolean}} OcrOutcome */

const EMPTY = { fullText: '', textAnnotations: [], geometry: false }

/**
 * OwOCR's protocol: send the image, receive a boolean status line, then the
 * recognised text. Anything else — including a silent server — resolves as a
 * failure rather than hanging the scan loop.
 */
export function websocketText(frame, url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let socket
    let messages = 0
    const timer = setTimeout(() => {
      socket?.close()
      reject(new Error(`WebSocket OCR timed out after ${timeoutMs}ms (${url})`))
    }, timeoutMs)
    const finish = (fn, value) => {
      clearTimeout(timer)
      socket?.close()
      fn(value)
    }

    try {
      socket = new WebSocket(url)
    } catch (error) {
      clearTimeout(timer)
      reject(new Error(`WebSocket OCR could not connect to ${url}: ${error?.message ?? error}`))
      return
    }
    socket.onopen = () => {
      frameBlob(frame).then(
        (blob) => socket.send(blob),
        (error) => finish(reject, error)
      )
    }
    socket.onmessage = (event) => {
      messages++
      if (messages === 1) {
        if (event.data !== 'True') finish(reject, new Error('WebSocket OCR server reported failure'))
        return
      }
      finish(resolve, String(event.data))
    }
    socket.onerror = () => finish(reject, new Error(`WebSocket OCR connection failed (${url})`))
  })
}

/**
 * Recognise a captured frame using the configured mode.
 *
 * @returns {Promise<OcrOutcome|null>}
 */
export async function recognize(frame, settings) {
  switch (settings.ocrMode) {
    case 'websocket': {
      const text = (await websocketText(frame, settings.owocrWebSocketUrl)).trim()
      return normalizeOcrResult({ ...EMPTY, fullText: text }, 'websocket')
    }
    case 'mangaocr':
    case 'oneocr':
    case 'meikiocr':
    default: {
      const result = await ocrFrame(
        frame,
        settings.ocrMode === 'local' ? 'meikiocr' : ['meikiocr', 'mangaocr', 'oneocr'].includes(settings.ocrMode) ? settings.ocrMode : 'cloud'
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
