/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Hachidori's Sharing → Link to a relay, through Kimochi (src-tauri/src/relay_link.rs).
 *
 * A relay admits a link only from a browser extension's origin or the native Hoshidicts apps'
 * `hoshi://hoshidicts`, and a page cannot choose the `Origin` its WebSocket sends, so from
 * Hachidori's loopback origin every link was refused ("No shared Hachidori answered at …"). Here
 * the background page's `WebSocket` sends a link address (`ws://<host>:<port>/link`, the only form
 * sharing-protocol.js `parseLinkAddress` makes) to the same origin's bridge instead, which opens
 * the relay with the native origin and then only copies bytes. Every other socket is the native
 * one, untouched, and a bridged one is the native one too: frames never pass through script.
 *
 * Only on the loopback origin (`http://127.0.0.1:<port>`), the one that serves the bridge; on
 * Hachidori's scheme origin linking stays as it was.
 */

export const BRIDGE_PATH = '/__kimochi/relay-link'
const LINK_PATH = '/link'
const MARK = Symbol.for('kimochi.relayLink')

/** The bridge URL for `url` on the page at `location`, or null when `url` is not a relay link. */
export function bridgeUrl(url, location) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return null
  }
  if (parsed.protocol !== 'ws:' || parsed.pathname !== LINK_PATH || parsed.username || parsed.password || parsed.hostname === '') return null
  const to = parsed.port === '' ? `${parsed.host}:80` : parsed.host
  return `ws://${location.host}${BRIDGE_PATH}?to=${encodeURIComponent(to)}`
}

/** Whether the page at `location` is on the loopback origin, which serves the bridge. */
export function servesBridge(location) {
  return location?.protocol === 'http:' && location.hostname === '127.0.0.1' && location.port !== ''
}

/** Route `win`'s relay links through the bridge. Returns whether it did (once per window). */
export function installRelayLink(win) {
  const Native = win.WebSocket
  if (typeof Native !== 'function' || Native[MARK] || !servesBridge(win.location)) return false
  const location = win.location
  class WebSocket extends Native {
    constructor(url, protocols) {
      const bridged = bridgeUrl(url, location)
      super(bridged ?? url, protocols)
      // Hachidori sees the address it asked for.
      if (bridged !== null) Object.defineProperty(this, 'url', { value: new URL(String(url)).href, configurable: true })
    }
  }
  Object.defineProperty(WebSocket, MARK, { value: true })
  win.WebSocket = WebSocket
  return true
}
