/**
 * The database-worker side of Yomitan's media drawing protocol.
 *
 * In a normal extension the display transfers OffscreenCanvases to a media
 * drawing worker, which forwards the requests over a MessagePort to the
 * dictionary database worker living with the backend. That port cannot cross a
 * window boundary, so in a relayed window the backend never receives it and
 * dictionary images never appear.
 *
 * It does not have to. The port's two ends are both inside the relayed window:
 * the media worker holds one, and the application hands the other to the
 * "backend". Keeping that end here and answering it locally closes the gap —
 * the bytes come from the backend over the ordinary JSON relay, via
 * `getMedia`, which already returns base64 content for exactly this reason.
 *
 * This module holds the parts that are pure: grouping the requests the way the
 * real database worker groups them, and decoding what comes back. The DOM work
 * lives in host/panel-media.js.
 */

export interface DrawMediaRequest {
  path: string
  dictionary: string
  canvasIndex: number
  canvasWidth: number
  canvasHeight: number
  generation: number
}

export interface GroupedMediaRequest {
  path: string
  dictionary: string
  canvasIndexes: number[]
  canvasWidth: number
  canvasHeight: number
  generation: number
}

/** What `getMedia` returns: `content` is base64, not bytes. */
export interface MediaRecord {
  path: string
  dictionary: string
  content: string
  mediaType: string
  width?: number
  height?: number
}

/** `path:::dictionary`, matching the database worker's own key. */
export function mediaKey(item: { path: string; dictionary: string }): string {
  return `${item.path}:::${item.dictionary}`
}

/**
 * Merge requests that want the same image.
 *
 * One entry appears several times when a dictionary shows the same glyph in
 * several places, and each occurrence has its own canvas. Grouping means one
 * lookup and one decode per image rather than per canvas, which is the whole
 * reason the real worker does it — and it also fixes the canvas dimensions for
 * the group, since the protocol carries only one size per message.
 */
export function groupMediaRequests(requests: DrawMediaRequest[]): GroupedMediaRequest[] {
  const groups = new Map<string, GroupedMediaRequest>()
  for (const request of requests) {
    const { path, dictionary, canvasIndex, canvasWidth, canvasHeight, generation } = request
    const key = mediaKey(request)
    let group = groups.get(key)
    if (!group) {
      group = { path, dictionary, canvasIndexes: [], canvasWidth, canvasHeight, generation }
      groups.set(key, group)
    }
    group.canvasIndexes.push(canvasIndex)
  }
  return [...groups.values()]
}

/** The distinct `{path, dictionary}` pairs to ask the backend for. */
export function mediaTargets(
  groups: GroupedMediaRequest[]
): { path: string; dictionary: string }[] {
  return groups.map(({ path, dictionary }) => ({ path, dictionary }))
}

export function indexMedia(records: MediaRecord[]): Map<string, MediaRecord> {
  return new Map(records.map((record) => [mediaKey(record), record]))
}

/** Match Yomitan API._invoke: runtime messages return {result} or {error}. */
export function mediaFromReply(reply: {
  result?: MediaRecord[]
  error?: { message?: string }
}): MediaRecord[] {
  if (reply?.error) throw new Error(reply.error.message ?? 'Dictionary media lookup failed')
  if (!Array.isArray(reply?.result)) throw new Error('Invalid dictionary media response')
  return reply.result
}

/**
 * Decode base64 content to bytes.
 *
 * `getMedia` base64-encodes because its results cross a message boundary as
 * JSON; this undoes exactly that.
 */
export function base64ToBytes(base64: string, decode: (value: string) => string): Uint8Array {
  const binary = decode(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * SVG has to be rasterised at the size it will be shown, because it has no
 * intrinsic pixel size to fall back on. Raster formats are scaled the same way,
 * so both take the same path.
 */
export function isVectorMedia(mediaType: string): boolean {
  return mediaType === 'image/svg+xml'
}

/** A group with no matching record: the dictionary references media it lacks. */
export function missingMedia(
  groups: GroupedMediaRequest[],
  records: MediaRecord[]
): GroupedMediaRequest[] {
  const found = indexMedia(records)
  return groups.filter((group) => !found.has(mediaKey(group)))
}
