/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * `tabs.captureVisibleTab` (DICTIONARY_ENGINES.md §11): in Kimochi the "visible tab" is the
 * overlay drawn over a game, which is transparent and capture-protected, so a screenshot of it
 * would show nothing. What the reader is looking at is the captured source frame, the game
 * window or display Kimochi OCRs, so that is what a capture answers with.
 *
 * Native names the frame (`capture_frame_source`), the pixels come over the `capture:` protocol
 * like every other frame, and they are re-encoded here to the format and quality the extension
 * asked for. Nothing about the pixels is ever reported; only their size.
 */

/** Chromium's default JPEG quality for `captureVisibleTab` (capture_web_contents_function.cc). */
export const DEFAULT_QUALITY = 90
const FORMATS = ['jpeg', 'png']

/**
 * `captureVisibleTab(windowId?, options?)` arguments, validated the way Chrome's schema does.
 * Kimochi has one window (id 1, also reachable as `WINDOW_ID_CURRENT`, -2).
 */
export function captureArgs(windowId, options) {
  if (windowId !== undefined && windowId !== null && windowId !== 1 && windowId !== -2) {
    throw Error(`No window with id: ${windowId}.`)
  }
  const format = options?.format ?? 'jpeg'
  if (!FORMATS.includes(format)) {
    throw Error(`Error in invocation of tabs.captureVisibleTab(optional integer windowId, optional extensionTypes.ImageDetails options, optional function callback): Error at parameter 'options': Error at property 'format': Value must be one of jpeg, png.`)
  }
  const quality = options?.quality ?? DEFAULT_QUALITY
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
    throw Error(`Error in invocation of tabs.captureVisibleTab(optional integer windowId, optional extensionTypes.ImageDetails options, optional function callback): Error at parameter 'options': Error at property 'quality': Value must be an integer between 0 and 100.`)
  }
  return { format, quality }
}

/** `data:<type>;base64,…` of a blob, in chunks so a large frame does not overflow the stack. */
export async function dataUrlOf(blob, type) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return `data:${type};base64,${btoa(binary)}`
}

/**
 * Fetch the frame at `url` and answer with a data URL in `format`. A PNG asked of a PNG source
 * passes through untouched; anything else is drawn to a canvas and encoded there (JPEG over
 * black, as Chrome's capture is opaque). A frame the store no longer holds is `gone`, which the
 * hub retries once with a fresh frame.
 */
export async function encodeFrame(win, url, { format, quality }) {
  const type = `image/${format}`
  const response = await win.fetch(url)
  if (!response.ok) {
    const error = Error(`the captured frame is no longer available (${response.status})`)
    error.gone = response.status === 404
    throw error
  }
  const blob = await response.blob()
  if (blob.type === type && format === 'png') return dataUrlOf(blob, type)
  const bitmap = await win.createImageBitmap(blob)
  const canvas = win.document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d')
  if (format === 'jpeg') {
    context.fillStyle = '#000'
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  context.drawImage(bitmap, 0, 0)
  bitmap.close?.()
  const encoded = typeof canvas.toBlob === 'function'
    ? await new Promise((resolve) => canvas.toBlob(resolve, type, quality / 100))
    : null
  if (encoded) return dataUrlOf(encoded, type)
  return canvas.toDataURL(type, quality / 100)
}

/** The Log line a lookup was made on: `ocr.scanId` of the transcript row (LineRow.tsx). */
export function scanOf(element) {
  const scan = element?.closest?.('[data-ocr-scan]')?.getAttribute?.('data-ocr-scan')
  return scan ? String(scan) : null
}
