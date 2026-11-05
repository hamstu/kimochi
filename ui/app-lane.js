/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The fast lane between Kimochi's own windows (the overlay, the Log, the dictionary pop-up's
 * window, the dictionary panel): BroadcastChannels on the app's origin, one per window label
 * (`kimochi-app-lane:<label>`), carrying the same payloads as `ext_relay`. The windows share one
 * browser profile, so a message crosses inside the browser: a dictionary result in about a
 * millisecond, where `ext_relay` (a native request out of one webview, an event evaluated in the
 * other) takes ten or more. Built-in Yomitan's lookups in the Log cross between windows several
 * times each (its backend is the overlay's; its pop-up has a window of its own).
 *
 * A window uses the lane to another only once that window has said it is on it: each announces
 * itself on a shared channel as it starts, and the others answer. Until then, and anywhere the
 * channels do not reach (a webview that keeps windows apart), `ext_relay` carries everything as
 * before. Callers choose per conversation and keep to it (a request's answer comes back the way
 * it went; a port keeps the way it opened on), since the two roads do not keep order between
 * them. Plain DOM, no imports: the overlay loads `ui/` modules as they are.
 *
 * The extension engines' own lane (host/ext/lane.js) is on the extension's origin; this one is
 * on the app's, and only Kimochi's documents run there.
 */

const SHARED = 'kimochi-app-lane'
const own = (label) => `${SHARED}:${label}`

/**
 * This window's end of the lane, one per window: `{reachable(label), send(label, payload),
 * listen(onPayload)}`. `send` answers false when the payload must go by `ext_relay` instead.
 */
export function openAppLane(win, label) {
  if (win.__kimochiAppLane) return win.__kimochiAppLane
  const listeners = new Set()
  const lane = {
    reachable: () => false,
    send: () => false,
    listen(onPayload) {
      listeners.add(onPayload)
      return () => listeners.delete(onPayload)
    }
  }
  win.__kimochiAppLane = lane
  if (!label || win.__kimochiNoLane || typeof win.BroadcastChannel !== 'function') return lane
  let mine
  let shared
  try {
    mine = new win.BroadcastChannel(own(label))
    shared = new win.BroadcastChannel(SHARED)
  } catch {
    return lane
  }
  const peers = new Set()
  const outs = new Map()
  let closed = false
  mine.onmessage = ({ data }) => {
    if (!data || typeof data.from !== 'string' || !data.payload) return
    peers.add(data.from)
    for (const listener of listeners) listener(data.payload, data.from)
  }
  shared.onmessage = ({ data }) => {
    if (!data || typeof data.label !== 'string' || data.label === label) return
    if (data.t === 'here') {
      peers.add(data.label)
      if (!data.reply) shared.postMessage({ t: 'here', label, reply: true })
    } else if (data.t === 'gone') {
      peers.delete(data.label)
    }
  }
  shared.postMessage({ t: 'here', label })
  win.addEventListener('pagehide', () => {
    closed = true
    shared.postMessage({ t: 'gone', label })
    mine.close()
    shared.close()
    for (const out of outs.values()) out.close()
  })
  lane.reachable = (to) => !closed && peers.has(to)
  lane.send = (to, payload) => {
    if (!lane.reachable(to)) return false
    let out = outs.get(to)
    if (!out) outs.set(to, (out = new win.BroadcastChannel(own(to))))
    out.postMessage({ from: label, payload })
    return true
  }
  return lane
}
