/**
 * Settings → Anki's model: the AnkiConnect address as typed, what the connection check found
 * (`anki_connect_status`, src-tauri/src/reader/ankiconnect.rs), and how each dictionary engine adds
 * cards. No React and no Tauri, so scripts/anki-connect.test.mjs can pin it.
 *
 * Every AnkiConnect request leaves from Rust without an Origin header: Kimochi's own to the address
 * set here, the dictionary extensions' to the one in their own settings (host/anki-relay.js). AnkiConnect admits a
 * request without an Origin whatever its `webCorsOriginList` says (26.10's web.py `allowOrigin`, and
 * every release before it), so no setup needs Kimochi's origins added there, and none is suggested:
 * a refusal (`blocked`) comes from something else at that address.
 */
import type { DictionaryEngine } from './settings'

export const DEFAULT_ANKI_CONNECT_URL = 'http://127.0.0.1:8765'
export const DEFAULT_ANKI_CONNECT_PORT = 8765

/** `anki_connect_status`'s answer, tagged by `state`. */
export type AnkiConnectStatus =
  | { state: 'connected'; url: string; version: number; latencyMs: number; keyRequired: boolean }
  | { state: 'keyRequired'; url: string }
  | { state: 'keyRejected'; url: string }
  | { state: 'notRunning'; url: string; suggestion: string | null }
  | { state: 'timeout'; url: string }
  | { state: 'notAnkiConnect'; url: string; detail: string; suggestion: string | null }
  | { state: 'blocked'; url: string; status: number }
  | { state: 'invalidUrl'; url: string; error: string }
  | { state: 'error'; url: string; message: string }

export type AnkiAddress = { ok: true; url: string } | { ok: false; error: string }

/**
 * The address as typed, made whole and checked the way Rust checks it (`parse_url`): empty is the
 * default, a bare port is that port on 127.0.0.1, and a missing `http://` is added. The result has
 * no trailing slash.
 */
export function normalizeAnkiConnectUrl(input: string): AnkiAddress {
  const example = `Use an address like ${DEFAULT_ANKI_CONNECT_URL}.`
  let text = input.trim()
  if (text === '') return { ok: true, url: DEFAULT_ANKI_CONNECT_URL }
  if (/^\d+$/.test(text)) text = `http://127.0.0.1:${text}`
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: `“${input.trim()}” is not an address. ${example}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, error: `The address must start with http:// or https://. ${example}` }
  if (!url.hostname) return { ok: false, error: `The address has no host. ${example}` }
  if (url.username || url.password)
    return { ok: false, error: 'The address must not contain a user name or password.' }
  if (url.search || url.hash)
    return { ok: false, error: `The address must not have a query or fragment. ${example}` }
  // `URL` drops a scheme's default port, so "http://host:80" reads as no port, as in Rust.
  if (!url.port && url.protocol === 'http:')
    return {
      ok: false,
      error: `The address needs a port: AnkiConnect listens on ${DEFAULT_ANKI_CONNECT_PORT} unless its webBindPort says otherwise. ${example}`
    }
  if (url.pathname.replace(/\/+$/, '') === '/api/v1')
    return { ok: false, error: `Leave out /api/v1: Kimochi uses AnkiConnect's classic endpoint. ${example}` }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  return { ok: true, url: `${url.protocol}//${url.host}${path}` }
}

/** Whether the address is on this computer (AnkiConnect's default `webBindAddress`). */
export function isLocalAddress(address: string): boolean {
  try {
    const host = new URL(address).hostname
    return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

export type StatusTone = 'ok' | 'warn' | 'danger' | 'neutral'

export interface StatusText {
  tone: StatusTone
  /** A few words, next to the dot. */
  title: string
  /** What it means and what to do. */
  detail: string
}

/** What the connection check found, for people. `null` is a check still on its way. */
export function describeAnkiStatus(status: AnkiConnectStatus | null): StatusText {
  if (!status) return { tone: 'neutral', title: 'Checking…', detail: 'Asking AnkiConnect.' }
  switch (status.state) {
    case 'connected':
      return {
        tone: 'ok',
        title: 'Connected',
        detail: `AnkiConnect (API version ${status.version}) answers at ${status.url}${
          status.keyRequired ? ', and accepts the API key' : ''
        }.`
      }
    case 'keyRequired':
      return {
        tone: 'warn',
        title: 'API key needed',
        detail: 'AnkiConnect has an API key set. Enter the same key below.'
      }
    case 'keyRejected':
      return {
        tone: 'danger',
        title: 'Wrong API key',
        detail: "AnkiConnect did not accept the API key. It must match the apiKey in AnkiConnect's config."
      }
    case 'notRunning':
      return status.suggestion
        ? {
            tone: 'warn',
            title: 'Wrong port',
            detail: `Nothing answers at ${status.url}, but AnkiConnect does at ${status.suggestion}.`
          }
        : {
            tone: 'warn',
            title: 'Not running',
            detail: `Nothing answers at ${status.url}. Open Anki, and check that the AnkiConnect add-on is installed and the port matches its webBindPort.`
          }
    case 'timeout':
      return {
        tone: 'warn',
        title: 'Not answering',
        detail: `AnkiConnect at ${status.url} did not answer in time. Anki may be busy (a dialog open, or syncing).`
      }
    case 'notAnkiConnect':
      return {
        tone: 'danger',
        title: 'Wrong port',
        detail: status.suggestion
          ? `Something other than AnkiConnect answers at ${status.url}. AnkiConnect answers at ${status.suggestion}.`
          : `Something other than AnkiConnect answers at ${status.url} (${status.detail}). Check the port against AnkiConnect's webBindPort.`
      }
    case 'blocked':
      return {
        tone: 'danger',
        title: 'Refused',
        detail: `${status.url} refused Kimochi's request (HTTP ${status.status}). Kimochi's requests carry no browser origin, which AnkiConnect accepts whatever its webCorsOriginList says, so something else is refusing them: check that the address points straight at AnkiConnect, not at a proxy.`
      }
    case 'invalidUrl':
      return { tone: 'danger', title: 'Invalid address', detail: status.error }
    case 'error':
      return { tone: 'danger', title: 'Error', detail: status.message }
  }
}

/** How often the check runs while Settings → Anki is open: sooner while it is not connected. */
export function nextCheckMs(status: AnkiConnectStatus | null): number {
  return status?.state === 'connected' ? 15000 : 4000
}

/** Who builds the card for each engine. */
export type AnkiRoute =
  /** Kimochi's own pop-up adds the card; its settings are on the Anki page. */
  | 'kimochi'
  /** The engine adds the card from its own pop-up; its settings are in the engine's settings. */
  | 'engine'
  /** The engine has no Anki support. */
  | 'none'

export const ANKI_ROUTE: Record<DictionaryEngine, AnkiRoute> = {
  yomitan: 'engine',
  hachidori: 'engine',
  tenten: 'none',
  'custom-api': 'kimochi'
}
