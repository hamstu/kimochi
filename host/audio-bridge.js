/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Dictionary audio, as a real extension gets it.
 *
 * Two things a browser gives the extension that this host has to supply itself:
 *
 *  - **Cross-origin reads from the backend.** An extension's background page holds host
 *    permissions, so `fetch` to an audio server needs no CORS headers. Ours is an ordinary
 *    page, and a local audio server (the Anki "Local Audio Server" add-on, a custom URL, a
 *    custom JSON list) sends none, so every request failed and Yomitan fell through to its
 *    next source. `installBackendFetch` sends the backend's cross-origin GET and HEAD
 *    requests through the native `extension_fetch` command instead: anonymous (no cookies,
 *    no credentials), size- and time-limited. Anything else — AnkiConnect's POSTs, same-origin
 *    extension files — keeps the page's own `fetch`.
 *
 *  - **Recognising JapanesePod101's "audio not available" clip.** JapanesePod101 answers a
 *    word it has no recording for with a spoken "this audio is not available", and Yomitan
 *    skips it by its exact duration — the values Chrome and Firefox report. WebKit reports
 *    another, so the clip played as the word's audio. `installAudioValidity` accepts any
 *    duration within a few hundredths of a second of it; real word recordings are about a
 *    second long.
 *
 * Nothing in `yomitan/` is modified; this wraps a prototype and `fetch`, as the rest of the
 * host wraps `chrome.*`.
 */

const INSTALLED = Symbol.for('kimochi.audioBridge.installed')

/** The "not available" clip, about 5.65–5.69 s depending on the decoder. */
const UNAVAILABLE_CLIP = { min: 5.6, max: 5.75 }

function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Route this realm's cross-origin GET/HEAD `fetch` calls through native code.
 *
 * @param {(command: string, args: object) => Promise<any>} invoke
 * @param {(value: object) => void} log
 */
export function installBackendFetch(invoke, log) {
  if (globalThis[INSTALLED]?.fetch) return
  globalThis[INSTALLED] = { ...globalThis[INSTALLED], fetch: true }
  const pageFetch = globalThis.fetch.bind(globalThis)
  let reported = false

  globalThis.fetch = async function (input, init = {}) {
    const request = input instanceof Request ? input : null
    const href = request ? request.url : String(input)
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase()
    let url
    try {
      url = new URL(href, location.href)
    } catch {
      return pageFetch(input, init)
    }
    const crossOrigin =
      (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin
    if (!crossOrigin || (method !== 'GET' && method !== 'HEAD')) return pageFetch(input, init)
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')

    try {
      const result = await invoke('extension_fetch', { url: url.href, method })
      if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      const body = method === 'HEAD' || !result.body ? null : base64ToBytes(result.body)
      // A Response cannot carry a 1xx/204/304 status with a body; the status alone is enough.
      const nullBody = [101, 204, 205, 304].includes(result.status)
      return new Response(nullBody ? null : body, {
        status: result.status,
        statusText: result.statusText ?? '',
        headers: result.headers ?? []
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      if (!reported) {
        reported = true
        log({ check: 'extension-fetch-failed', host: url.host, error: String(error?.message ?? error) })
      }
      // `fetch` rejects with a TypeError on a network failure; Yomitan treats it as one.
      throw new TypeError(`Failed to fetch ${url.host}: ${error?.message ?? error}`)
    }
  }
}

/**
 * Teach this realm's `AudioSystem` to recognise the "not available" clip under WebKit.
 *
 * @param {string} audioSystemUrl the URL of Yomitan's `js/media/audio-system.js` in this realm
 */
export async function installAudioValidity(audioSystemUrl) {
  const { AudioSystem } = await import(audioSystemUrl)
  if (AudioSystem.prototype[INSTALLED]) return
  AudioSystem.prototype[INSTALLED] = true
  const isAudioValid = AudioSystem.prototype._isAudioValid
  if (typeof isAudioValid !== 'function') return
  AudioSystem.prototype._isAudioValid = function (audio, sourceType) {
    if (sourceType === 'jpod101') {
      const duration = audio?.duration
      if (duration >= UNAVAILABLE_CLIP.min && duration <= UNAVAILABLE_CLIP.max) return false
    }
    return isAudioValid.call(this, audio, sourceType)
  }
}
