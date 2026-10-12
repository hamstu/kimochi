/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/** Small pieces every part of the generic host shares. */
import { ENGINES } from './engines.js'
import { platformInfo } from './primitives.js'

/** Chrome's own wording; Hachidori's relay retries on it (background-core.js `NOT_LISTENING`). */
export const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
export const PORT_CLOSED = 'The message port closed before a response was received.'

// The engine-independent pieces live in primitives.js, which the Yomitan shims share
// (DICTIONARY_ENGINES.md §11.4); re-exported so the generic host keeps one import site.
export { ChromeEvent, describe, json, platformInfo, resolveEngine, sleep, tabIdFor, within } from './primitives.js'

export function randomId(prefix = '') {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/**
 * The origin an engine is served from (§4): native's `__kimochiExtensionOrigins`, else the
 * platform convention (`http://<id>.localhost` on Windows, `<id>://localhost` elsewhere).
 */
export function extensionOrigin(engine, win = window) {
  const given = win.__kimochiExtensionOrigins?.[engine]
  if (typeof given === 'string' && given) return given.replace(/\/+$/, '')
  return platformInfo(win).os === 'win' ? `http://${engine}.localhost` : `${engine}://localhost`
}

/**
 * Which engine an extension-origin document belongs to, when the app's localStorage mirror is out
 * of reach (it is another origin's). In order: native's origin table, the scheme or host name
 * (`hachidori://localhost`, `http://hachidori.localhost`), the background page's `?engine=`, and
 * finally the document's own `/manifest.json` (the dev server's per-port origins carry no name).
 */
export function engineForExtensionOrigin(win = window) {
  const { origin, protocol, hostname, search } = win.location
  // Native's prelude names the engine of a frame whose own origin is an extension origin.
  const prelude = win.__kimochiDictionaryEngine
  if (ENGINES[prelude]) {
    const given = win.__kimochiExtensionOrigins?.[prelude]
    if (typeof given !== 'string' || given.replace(/\/+$/, '') === origin) return prelude
  }
  for (const [id, value] of Object.entries(win.__kimochiExtensionOrigins ?? {})) {
    if (typeof value === 'string' && value.replace(/\/+$/, '') === origin && ENGINES[id]) return id
  }
  for (const id of Object.keys(ENGINES)) {
    if (protocol === `${id}:` || hostname === `${id}.localhost`) return id
  }
  const fromQuery = new URLSearchParams(search).get('engine')
  if (fromQuery && ENGINES[fromQuery]) return fromQuery
  if (!/^https?:$/.test(protocol)) return null
  try {
    // Synchronous on purpose: the extension's own scripts run right after this one, and the
    // whole `chrome.*` surface depends on knowing the engine first. Same-origin and tiny.
    const xhr = new win.XMLHttpRequest()
    xhr.open('GET', '/manifest.json', false)
    xhr.send()
    if (xhr.status !== 200) return null
    const manifest = JSON.parse(xhr.responseText)
    for (const [id, engine] of Object.entries(ENGINES)) {
      if (manifest.name === engine.manifest.name && manifest.version === engine.manifest.version) return id
    }
  } catch {
    // Not an extension origin at all.
  }
  return null
}

/**
 * The origin of a URL as a document would report it. `new URL(x).origin` is "null" for
 * non-special schemes (`hachidori://localhost/…`), while the document served from it reports
 * `hachidori://localhost`, so origins are compared by protocol and host instead.
 */
export function originOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.origin
  } catch {
    return ''
  }
}
