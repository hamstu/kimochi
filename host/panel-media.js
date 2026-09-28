/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Dictionary images in a relayed window.
 *
 * Yomitan's display transfers OffscreenCanvases to a media drawing worker; that
 * worker forwards each request over a MessagePort to the dictionary database
 * worker, which reads the bytes and posts pixels back for the worker to draw.
 * In a relayed window the port's far end is meant to reach a backend in another
 * WebView, which a MessagePort cannot do — so without this adapter the media
 * worker holds a port nobody answers and every dictionary image stays blank.
 *
 * Both ends of that port are in fact inside this window. Keeping the end the
 * application meant to hand to the backend, and answering it here, is enough:
 * the bytes arrive over the ordinary JSON relay through `getMedia`, which
 * already base64-encodes its results precisely because they cross a message
 * boundary. No MessagePort needs to cross the native layer, no distributed extension
 * file is modified, and the original popup renders its own images.
 *
 * Decoding happens through an `HTMLImageElement` and a document canvas rather
 * than `ImageDecoder` or `createImageBitmap`'s resize options. That is
 * deliberate for two reasons: this adapter runs in a window and so has a DOM
 * the real worker does not, and it makes SVG and raster formats the same path.
 * `drawImage` scales to the destination, so the pixels handed back always match
 * the canvas exactly, which `putImageData` on the other side requires.
 */

import {
  groupMediaRequests,
  mediaTargets,
  indexMedia,
  mediaFromReply,
  mediaKey,
  base64ToBytes
} from '/ui/media.js'

/**
 * Answer one media drawing port.
 *
 * @param {MessagePort} port the end the application intended for the backend
 * @param {{getMedia: (targets: {path: string, dictionary: string}[]) => Promise<{result?: object[], error?: {message?: string}}>,
 *          log: (value: object) => void}} deps
 */
export function serveMedia(port, { getMedia, log }) {
  port.addEventListener('message', (event) => {
    const message = event.data
    if (message?.action !== 'drawMedia') return
    void draw(port, message.params?.requests ?? [], { getMedia, log })
  })
  port.addEventListener('messageerror', () => log({ check: 'panel-media-messageerror' }))
  port.start()
}

async function draw(port, requests, { getMedia, log }) {
  if (!requests.length) return
  const groups = groupMediaRequests(requests)
  let records
  try {
    records = mediaFromReply(await getMedia(mediaTargets(groups)))
  } catch (error) {
    log({ check: 'panel-media-lookup-failed', error: String(error?.message ?? error) })
    return
  }

  const found = indexMedia(records ?? [])
  let missing = 0
  for (const group of groups) {
    const record = found.get(mediaKey(group))
    // A dictionary referencing media it does not contain is the dictionary's
    // problem, not an error here; the canvas simply stays empty, as it would in
    // a real extension.
    if (!record) {
      missing++
      continue
    }
    try {
      const pixels = await rasterise(record, group)
      if (!pixels) continue
      port.postMessage(
        {
          action: 'drawBufferToCanvases',
          params: {
            buffer: pixels.buffer,
            width: pixels.width,
            height: pixels.height,
            canvasIndexes: group.canvasIndexes,
            generation: group.generation
          }
        },
        [pixels.buffer]
      )
    } catch (error) {
      log({
        check: 'panel-media-decode-failed',
        path: group.path,
        mediaType: record.mediaType,
        error: String(error?.message ?? error)
      })
    }
  }
  if (missing > 0) log({ check: 'panel-media-missing', count: missing })
}

/**
 * Decode one image and return it at exactly the canvas's size.
 *
 * The far side does `putImageData(..., 0, 0)`, which neither scales nor clips
 * gracefully, so the returned buffer has to match the canvas dimensions the
 * media worker recorded when it took the canvases.
 */
async function rasterise(record, group) {
  const width = Math.max(1, Math.round(group.canvasWidth))
  const height = Math.max(1, Math.round(group.canvasHeight))
  const bytes = base64ToBytes(record.content, atob)
  const blob = new Blob([bytes], { type: record.mediaType })
  const url = URL.createObjectURL(blob)
  try {
    const image = await loadImage(url, width, height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('2D canvas unavailable for media drawing')
    context.clearRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    const data = context.getImageData(0, 0, width, height)
    return { buffer: data.data.buffer, width, height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(url, width, height) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    // An SVG with no intrinsic size needs to be told how large to render; a
    // raster image ignores these and keeps its own dimensions.
    image.width = width
    image.height = height
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Image could not be decoded'))
    image.src = url
  })
}
