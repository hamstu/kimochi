/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The three OCR backends, behind one call.
 *
 * Electron exposed the same three on its preload bridge (perform-google-ocr,
 * perform-ocr, perform-ow-ocr). Only the cloud endpoint returns bounding boxes;
 * Tesseract and OwOCR return plain text. That asymmetry is preserved and
 * reported rather than hidden — `geometry: false` tells the overlay there is
 * nothing to position, so it publishes the text to history, the texthooker and
 * TTS and renders no boxes, instead of looking broken.
 */

import { ocrFrame } from './native.js'
import { frameBlob } from './frames.js'

/** @typedef {{fullText: string, textAnnotations: unknown[], geometry: boolean}} OcrOutcome */

const EMPTY = { fullText: '', textAnnotations: [], geometry: false }

let tesseract = null
let tesseractError = null

/**
 * Tesseract is loaded on demand: it is only reached when Local is the chosen OCR
 * mode, and the language data is far too heavy for the overlay's startup path.
 */
async function worker() {
  if (tesseract) return tesseract
  if (tesseractError) throw tesseractError
  try {
    const { createJapaneseWorker } = await import('./local-ocr-worker.js')
    tesseract = await createJapaneseWorker()
    return tesseract
  } catch (error) {
    tesseractError = new Error(
      `Local OCR is unavailable: tesseract.js could not be loaded (${error?.message ?? error}). ` +
        'Check that the build bundles ui/local-ocr-worker.js with its dependency.'
    )
    throw tesseractError
  }
}

export async function terminateLocalOcr() {
  const current = tesseract
  tesseract = null
  if (current) await current.terminate().catch(() => {})
}

/**
 * Plain recognised text, for the Local OCR mode.
 *
 * It used to double as the automatic loop's second gate. It no longer does: the
 * local first pass is the platform observer now, which reads Japanese far better
 * and needs neither this worker nor a fetch of the frame's PNG.
 */
export async function localText(frame) {
  const instance = await worker()
  const { data } = await instance.recognize(await frameBlob(frame))
  return data?.text ?? ''
}

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
    case 'local': {
      const text = (await localText(frame)).trim()
      return { ...EMPTY, fullText: text }
    }
    case 'websocket': {
      const text = (await websocketText(frame, settings.owocrWebSocketUrl)).trim()
      return { ...EMPTY, fullText: text }
    }
    default: {
      const result = await ocrFrame(frame)
      const ocr = result?.ocr
      if (!ocr) return null
      return {
        fullText: ocr.fullText ?? '',
        textAnnotations: ocr.textAnnotations ?? [],
        geometry: true,
        // `ocr_frame` publishes to the shared view, so the poll must recognise
        // this id as already applied rather than republishing it.
        nativeScanId: result.id ?? null
      }
    }
  }
}
