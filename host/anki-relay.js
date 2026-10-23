/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * The dictionary extensions' AnkiConnect requests, sent from Rust (`anki_connect_relay`,
 * src-tauri/src/reader/ankiconnect.rs) instead of plugin-http.
 *
 * plugin-http forwards the page's Origin (`tauri://localhost`, `http://tauri.localhost` on
 * Windows, `hachidori://localhost`, …), and AnkiConnect's default `webCorsOriginList`
 * (`["http://localhost"]`) answers those with HTTP 403, so Yomitan and Hachidori could not add a
 * card until the user edited AnkiConnect's config. A request from Rust carries no Origin, which
 * AnkiConnect always admits. Nothing else changes: the request goes to the address the extension
 * asked for, with the body (and the API key in it) the extension wrote, so its own Anki settings
 * stay in charge.
 *
 * A request is AnkiConnect's when it is a POST whose body is AnkiConnect's classic envelope: a
 * JSON object with a string `action`, a numeric `version` and nothing but `params` and `key`
 * besides. That is how Yomitan (anki-connect.js `_invoke`) and Hachidori (anki.js) call it, and
 * nothing else the extensions send looks like it.
 *
 * Used by host/network-entry.js (Built-in Yomitan) and host/ext/network.js (the extension host).
 */
import { invoke } from '@tauri-apps/api/core'

const FIELDS = new Set(['action', 'version', 'params', 'key'])
const NULL_BODY = new Set([101, 103, 204, 205, 304])

function bodyText(body) {
  if (typeof body === 'string') return body
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body)
    } catch {
      return null
    }
  }
  return null
}

/** The request's body as text when it is an AnkiConnect request, else null. */
export function ankiConnectBody(method, body) {
  if (String(method ?? 'GET').toUpperCase() !== 'POST') return null
  const text = bodyText(body)
  if (!text || text.trimStart()[0] !== '{') return null
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.action !== 'string' || !value.action || typeof value.version !== 'number') return null
  if (value.params !== undefined && (typeof value.params !== 'object' || value.params === null)) return null
  return Object.keys(value).every((k) => FIELDS.has(k)) ? text : null
}

/**
 * Send `body` (from `ankiConnectBody`) to `url` through Rust; resolves with AnkiConnect's answer as a
 * `Response` of `realm`, and rejects like `fetch` (TypeError, or AbortError) when it cannot be
 * reached. The reason goes to `report`, since the extension only shows "connection failure".
 */
export async function relayAnkiConnect(url, body, { signal = null, realm = globalThis, report = () => {} } = {}) {
  const aborted = () => new realm.DOMException('The operation was aborted.', 'AbortError')
  if (signal?.aborted) throw aborted()
  let reply
  try {
    const call = invoke('anki_connect_relay', { url: String(url), body })
    reply = signal
      ? await Promise.race([
          call,
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(aborted()), { once: true }))
        ])
      : await call
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    report({ check: 'anki-relay-failed', error: String(error?.message ?? error).slice(0, 300) })
    throw new realm.TypeError('Failed to fetch')
  }
  return new realm.Response(NULL_BODY.has(reply.status) ? null : reply.body, {
    status: reply.status,
    headers: { 'Content-Type': 'application/json' }
  })
}
