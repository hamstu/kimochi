/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * The fast lane between an engine's windows: `BroadcastChannel`s on the extension's origin, one per
 * window label (`kimochi-ext:<engine>:<label>`), carrying the same `{kind: 'ext', …}` payloads as
 * `ext_relay` (links.js). All of Kimochi's webviews share one browser profile, so a message
 * crosses between them inside the browser: a 100 KB dictionary result in about a millisecond,
 * where `ext_relay` (a native request out of one webview, a channel fetch into the other) takes
 * tens. Lookups send several such messages each, so this is most of the time between hovering a
 * word and seeing its entry.
 *
 * A document on the extension origin (the engine's hidden window) opens the channels itself. An
 * app document (the overlay, the Log, the dictionary panel) cannot, so it frames this origin's
 * `/__kimochi/lane.html`, whose host (`installLaneFrame`, from entry.js) opens them on its behalf
 * and passes messages over a private MessagePort. Where neither works (a webview that keeps
 * each window's storage apart, the test harness), `ready` answers false and `ext_relay` carries
 * everything as before.
 *
 * Only extension traffic travels here, and only between the windows of one engine. A channel on
 * the extension origin is open to that origin's documents, which are the extension's own pages:
 * the same code that already holds `chrome.*` in the hidden window, so nothing here is exposed to
 * anyone the relay did not already serve. `from` is what the sender says it is, as with the
 * relay's address filter: the hub authorises by context ownership, not by transport.
 */

/** The page an app document frames to reach the lane (served from `host/`, as dist/spike/). */
export const LANE_PATH = '/__kimochi/lane.html'
/** How long an app document waits for its lane frame before carrying on over `ext_relay`. */
const LANE_OPEN_MS = 5000

const channelName = (engine, label) => `kimochi-ext:${engine}:${label}`

/**
 * This window's end of the lane. `{ready, send(to, payload), listen(onPayload)}`: `ready` resolves
 * true once messages can go, false where they cannot; `onPayload(payload, from)` gets what other
 * windows sent this one.
 */
export function openLane(win, { engine, origin, label }) {
  // One per window: the overlay's hub and anything else there share it.
  const key = `${engine}:${label}`
  const lanes = (win.__kimochiLanes ??= new Map())
  if (lanes.has(key)) return lanes.get(key)
  const lane = createLane(win, { engine, origin, label })
  lanes.set(key, lane)
  return lane
}

function createLane(win, { engine, origin, label }) {
  const listeners = new Set()
  const deliver = (data) => {
    if (!data || typeof data !== 'object' || typeof data.from !== 'string' || !data.payload) return
    for (const listener of listeners) listener(data.payload, data.from)
  }
  const api = {
    ready: Promise.resolve(false),
    send: () => false,
    listen: (onPayload) => {
      listeners.add(onPayload)
      return () => listeners.delete(onPayload)
    }
  }
  if (!label || win.__kimochiNoLane || typeof win.BroadcastChannel !== 'function') return api

  // The extension's own origin: the channels are this document's to open.
  if (win.location.origin === origin) {
    let own
    try {
      own = new win.BroadcastChannel(channelName(engine, label))
    } catch {
      return api
    }
    own.onmessage = ({ data }) => deliver(data)
    const outs = new Map()
    let closed = false
    api.send = (to, payload) => {
      if (closed) return false
      let out = outs.get(to)
      if (!out) outs.set(to, (out = new win.BroadcastChannel(channelName(engine, to))))
      out.postMessage({ from: label, payload })
      return true
    }
    api.ready = Promise.resolve(true)
    // Leaving: whatever is still sent goes by the relay (and is likely moot).
    win.addEventListener('pagehide', () => {
      closed = true
      own.close()
      for (const out of outs.values()) out.close()
    })
    return api
  }

  // An app document: through a frame on the extension origin.
  const doc = win.document
  if (!doc?.createElement) return api
  let port = null
  api.send = (to, payload) => {
    if (!port) return false
    port.postMessage({ to, payload })
    return true
  }
  api.ready = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), LANE_OPEN_MS)
    const open = () => {
      const channel = new win.MessageChannel()
      channel.port1.onmessage = ({ data }) => {
        if (data?.t === 'open') {
          clearTimeout(timer)
          port = channel.port1
          resolve(true)
        } else if (data?.t === 'message') deliver(data.data)
        else if (data?.t === 'closed') {
          clearTimeout(timer)
          resolve(false)
        }
      }
      channel.port1.start?.()
      return channel.port2
    }
    // Native injects the host at document start, before there is a body to put the frame in.
    const mount = () => {
      try {
        const frame = doc.createElement('iframe')
        frame.hidden = true
        frame.setAttribute('aria-hidden', 'true')
        frame.setAttribute('data-no-scan', '')
        frame.setAttribute('data-kimochi-lane', '')
        frame.tabIndex = -1
        frame.style.cssText = 'display:none;position:fixed;width:0;height:0;border:0;'
        frame.addEventListener('load', () => {
          frame.contentWindow?.postMessage({ __kimochiLane: 'open', engine, label }, origin, [open()])
        }, { once: true })
        frame.src = `${origin}${LANE_PATH}`
        doc.body.append(frame)
      } catch {
        clearTimeout(timer)
        resolve(false)
      }
    }
    if (doc.body) mount()
    else win.addEventListener('DOMContentLoaded', mount, { once: true })
  })
  return api
}

/**
 * The lane frame (`/__kimochi/lane.html` on the extension origin), installed instead of the
 * extension host: opens its parent's channel and the ones it sends to, once its parent asks.
 */
export function installLaneFrame(win) {
  if (win === win.top) return
  win.addEventListener('message', (event) => {
    const data = event.data
    if (event.source !== win.parent || data?.__kimochiLane !== 'open' || !event.ports?.[0]) return
    if (typeof data.engine !== 'string' || typeof data.label !== 'string') return
    const port = event.ports[0]
    let own
    try {
      own = new win.BroadcastChannel(channelName(data.engine, data.label))
    } catch {
      // No channels on this origin (an opaque one): say so now, not at the parent's deadline.
      port.postMessage({ t: 'closed' })
      return
    }
    own.onmessage = ({ data: message }) => port.postMessage({ t: 'message', data: message })
    const outs = new Map()
    port.onmessage = ({ data: message }) => {
      if (!message || typeof message.to !== 'string') return
      let out = outs.get(message.to)
      if (!out) outs.set(message.to, (out = new win.BroadcastChannel(channelName(data.engine, message.to))))
      out.postMessage({ from: data.label, payload: message.payload })
    }
    port.start?.()
    port.postMessage({ t: 'open' })
  })
}
