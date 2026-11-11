/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Transports between contexts and the hub (DICTIONARY_ENGINES.md §5.2).
 *
 *   extension iframe ──postMessage + MessagePort──▶ its parent's Router
 *   Router (overlay / harness) ──direct calls──▶ Hub
 *   Router (log, dictionary panel, welcome) ──fast lane, or Tauri ext_relay──▶ Hub's relay server
 *   Router (extension window: background + its offscreen iframe) ──fast lane, or ext_relay──▶ Hub
 *
 * The fast lane (lane.js) is BroadcastChannels between the windows, inside the browser: a window
 * uses it when the hub answers its hello there, and `ext_relay` otherwise. Messages between the
 * extension window's own background and offscreen documents never leave it (`deliverLocally`).
 *
 * Every app top document that hosts an engine has one Router, and so does the top document of an
 * engine's hidden extension window (`ext-<id>`, DICTIONARY_ENGINES.md §5.4), whose background
 * context and offscreen iframe reach the overlay's hub over the relay. It registers the contexts of
 * that document and of its child frames with the hub, translating between their local identities and
 * the hub's context ids, so a hub that restarts (overlay reload) is re-registered with instead of
 * leaving the window talking to ids nobody knows.
 *
 * ## The iframe handshake
 *
 * An extension frame is cross-origin to its parent and has no `__TAURI__`. At document start it
 * posts one message to its parent: `{__kimochiExt: 'hello', v: 1, engine, nonce, kind, url,
 * documentId}` with a fresh MessagePort transferred alongside. The parent accepts it only if
 * `event.origin` is the active engine's extension origin and `event.source` is one of its own child
 * frames, then answers `{t: 'welcome', nonce}` on the port. From then on everything travels over
 * that private port (`call`/`reply`/`event`, fetch streams), never through `window.postMessage`
 * again, so no other script in either document can read or inject traffic.
 *
 * ## The relay
 *
 * Payloads on `ext_relay` are `{kind: 'ext', engine, type: 'call' | 'reply' | 'event' | 'ready', …}`.
 * The distinct `kind` keeps them out of ui/overlay.js `handleRelay` (Yomitan's `hello`/`request`
 * protocol), and the engine id drops traffic from a window still running the previous engine.
 * Native stamps `{from, to, seq}`; receivers filter on `to` and de-duplicate per-sender `seq`
 * exactly as the Yomitan panel host does (both use primitives.js `listenRelay`). Sends to one target are serialised, so a port's `connect`
 * can never overtake its first `postMessage`.
 */
import { extTauri, listenRelay as listenSharedRelay } from './primitives.js'
import { openLane } from './lane.js'
import { NO_RECEIVER, PORT_CLOSED, describe, json, originOf, randomId, sleep, within } from './util.js'

const CHILD_WELCOME_MS = 30000
const LOG_BUDGET_PER_MINUTE = 120
/** The contexts `runtime.sendMessage` from an extension context goes to (hub.js). */
const EXTENSION_KINDS = new Set(['background', 'offscreen', 'page'])
/** Contexts that say `ready` once their scripts have run (hub.js `register`). */
const STARTING_KINDS = new Set(['background', 'offscreen'])
/** As hub.js: a target that never says whether it has listeners is taken to have none. */
const DELIVERY_ACK_MS = 10000
const ANSWERED_KEPT = 500
/** How long a hello over the fast lane waits before the relay is asked instead (lane.js). */
const LANE_HELLO_MS = 1000
/** A window on the relay tries the lane again this often, this many times (`connectRelay`). */
const LANE_UPGRADE_MS = 3000
const LANE_UPGRADE_TRIES = 10

/** One serialised `ext_relay` sender per document. */
function relaySender(tauri) {
  const chains = new Map()
  return (target, payload) => {
    const key = target ?? '*'
    const next = (chains.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => typeof tauri.core.Channel === 'function' && typeof target === 'string'
        ? tauri.core.invoke('ext_relay_bytes', new TextEncoder().encode(JSON.stringify(payload)), { headers: { 'x-kimochi-target': target } })
        : tauri.core.invoke('ext_relay', { target, payload }))
    chains.set(key, next)
    return next
  }
}

/** What a dropped or late relay message was, for the evidence log: never its arguments. */
const relayWhat = (payload) => ({ type: payload?.type ?? payload?.kind ?? null, op: typeof payload?.op === 'string' ? payload.op : null })

/**
 * Listen to `ext-relay` with the shared address filter and per-sender de-duplication. A late
 * message is logged too: one dropped as a duplicate that was really late is how Hachidori's
 * startup read was lost.
 */
const listenRelay = (tauri, label, onPayload, report) =>
  listenSharedRelay(
    tauri,
    label,
    onPayload,
    (from, seq, payload) => report({ check: 'ext-host-relay-duplicate', from, seq, ...relayWhat(payload) }),
    (from, seq, highest, payload) => report({ check: 'ext-host-relay-reordered', from, seq, highest, ...relayWhat(payload) })
  )

// ---------------------------------------------------------------- Router

export class Router {
  constructor({ win, engine, descriptor, origin, label, report, network, save = null }) {
    this.win = win
    // `save(name, bytes)`: keep a file an extension page downloads (page.js). Only a window that
    // shows extension pages has one (app.js); elsewhere a download is refused.
    this.save = save
    this.engine = engine
    this.descriptor = descriptor
    this.origin = origin
    this.label = label
    this.report = report
    this.network = network
    this.endpoints = new Map()
    this.byHub = new Map()
    this.nextLocal = 0
    /** Every extension context the hub has, by its id, once it says (`deliverLocally`). */
    this.extensionIds = null
    /** Messages delivered within this document (`deliverLocally`), by their (negative) id. */
    this.localDeliveries = new Map()
    this.nextDelivery = 0
    /** The hub's deliveries this document already answered (`firstAnswer`). */
    this.answered = new Map()
    this.upstream = null
    let resolveUpstream
    this.upstreamReady = new Promise((resolve) => (resolveUpstream = resolve))
    this.resolveUpstream = resolveUpstream
  }

  /** Set (or replace, after a hub restart) the way to the hub, and register everything again. */
  setUpstream(upstream) {
    const replacing = this.upstream !== null
    this.upstream = upstream
    this.resolveUpstream(upstream)
    if (!replacing) return
    // First time: registrations already waiting on `upstreamReady` go ahead by themselves.
    this.upstreamReady = Promise.resolve(upstream)
    this.byHub.clear()
    this.extensionIds = null
    this.answered.clear()
    for (const endpoint of this.endpoints.values()) {
      endpoint.hubCtx = null
      endpoint.registered = this.register(endpoint)
    }
  }

  async register(endpoint) {
    const upstream = await this.upstreamReady
    const info = await upstream.call('register', endpoint.registration)
    if (!this.endpoints.has(endpoint.local)) {
      void upstream.call('unregister', { ctx: info.ctx }).catch(() => {})
      return info
    }
    if (this.upstream !== upstream) return info
    endpoint.hubCtx = info.ctx
    endpoint.info = info
    this.byHub.set(info.ctx, endpoint.local)
    return info
  }

  /**
   * A context of this document or of a child frame. `registration` is `{kind, url, documentId,
   * top}`; `onEvent` receives the hub's events for it. Returns `{call, detach, registered}`.
   */
  attach(registration, onEvent) {
    const endpoint = { local: ++this.nextLocal, registration: { label: this.label, ...registration }, onEvent, hubCtx: null }
    this.endpoints.set(endpoint.local, endpoint)
    endpoint.registered = this.register(endpoint)
    endpoint.registered.catch(() => {})
    const call = async (op, args = {}) => {
      if (op === 'sendMessage') {
        const local = this.deliverLocally(endpoint, args.message)
        if (local) return local
      }
      if (op === 'delivered') {
        if (typeof args.id === 'number' && args.id < 0) return this.localDelivered(endpoint.local, args)
        args = this.firstAnswer(args)
      }
      for (let attempt = 0; ; attempt += 1) {
        await endpoint.registered
        const upstream = this.upstream
        try {
          const value = await upstream.call(op, { ...args, ctx: endpoint.hubCtx })
          // A hub that restarts (overlay reload) while this document stays up is registered with
          // again; a background or offscreen context that already said `ready` says so in that
          // registration, since its scripts will not run a second time to say it again.
          if (op === 'ready') endpoint.registration.ready = true
          return value
        } catch (error) {
          // The hub restarted between registration and this call: register again, once.
          if (attempt === 0 && upstream !== this.upstream) continue
          throw error
        }
      }
    }
    return {
      call,
      registered: endpoint.registered,
      info: () => endpoint.info,
      detach: () => {
        if (!this.endpoints.delete(endpoint.local)) return
        for (const [id, d] of this.localDeliveries) {
          if (d.initial.delete(endpoint.local) || (d.pending.delete(endpoint.local) && (d.closed = true))) this.settleLocal(id, d)
        }
        if (endpoint.hubCtx !== null) {
          this.byHub.delete(endpoint.hubCtx)
          void this.upstream?.call('unregister', { ctx: endpoint.hubCtx }).catch(() => {})
        }
      }
    }
  }

  dispatch(hubCtx, event) {
    if (event?.type === 'extension-contexts') {
      this.extensionIds = new Set(event.ids)
      return
    }
    const endpoint = this.endpoints.get(this.byHub.get(hubCtx))
    if (endpoint) endpoint.onEvent(event)
  }

  // ------------------------------------------------------------ delivery within this document

  /**
   * `runtime.sendMessage` from an extension context of this document, delivered here when every
   * extension context there is lives here too (the engine's hidden window: its background and
   * offscreen documents) — exactly the contexts the hub would deliver to, without the trip to the
   * hub and back over the relay for each message and each answer. Chrome passes these within one
   * process; Hachidori sends many (each lookup is relayed from its background to its offscreen
   * document, and each Anki check sends every entry's fields), so through the hub they cost
   * megabytes of native round trips per lookup. Anything else, or anything not yet settled (a
   * context still starting, a page open elsewhere, a message the hub watches), goes to the hub.
   * Answers a promise like the hub's `deliver`, or null.
   */
  deliverLocally(from, message) {
    if (!EXTENSION_KINDS.has(from.registration.kind) || !this.extensionIds || from.hubCtx === null) return null
    if (this.descriptor?.hubObserves?.(message)) return null
    const ours = new Set()
    for (const endpoint of this.endpoints.values()) if (endpoint.hubCtx !== null) ours.add(endpoint.hubCtx)
    for (const id of this.extensionIds) if (!ours.has(id)) return null
    const targets = [...this.endpoints.values()].filter((e) => e !== from && EXTENSION_KINDS.has(e.registration.kind))
    if (targets.length === 0) return null
    for (const target of targets) {
      if (!this.extensionIds.has(target.hubCtx)) return null
      // The hub delivers only once the background (and, to a page, the offscreen document) has
      // run its scripts (hub.js `backgroundAwake`); a context still starting goes through it.
      if (STARTING_KINDS.has(target.registration.kind) && target.registration.ready !== true) return null
    }
    const id = -++this.nextDelivery
    const sender = this.senderFor(from)
    return new Promise((resolve, reject) => {
      const d = { resolve, reject, initial: new Set(targets.map((t) => t.local)), pending: new Set(), sawListener: false, closed: false }
      d.timer = setTimeout(() => {
        if (d.initial.size === 0) return
        this.report({ check: 'ext-host-delivery-unacknowledged', local: true })
        d.initial.clear()
        this.settleLocal(id, d)
      }, DELIVERY_ACK_MS)
      this.localDeliveries.set(id, d)
      // Each its own copy, as the relay would give it: a listener may change what it gets.
      for (const target of targets) {
        const event = { type: 'deliver', id, message: json(message), sender }
        queueMicrotask(() => target.onEvent(event))
      }
    })
  }

  /** A local context's answer to a message delivered by `deliverLocally` (hub.js `delivered`). */
  localDelivered(local, { id, status, value, error }) {
    const d = this.localDeliveries.get(id)
    if (!d) return undefined
    if (status === 'response') return this.finishLocal(id, d, () => d.resolve(json(value)))
    if (status === 'error') return this.finishLocal(id, d, () => d.reject(Error(error)))
    if (status === 'pending') {
      d.initial.delete(local)
      d.pending.add(local)
      d.sawListener = true
    } else if (status === 'unanswered') {
      d.initial.delete(local)
      d.sawListener = true
    } else if (status === 'none') d.initial.delete(local)
    this.settleLocal(id, d)
    return undefined
  }

  settleLocal(id, d) {
    if (d.initial.size > 0 || d.pending.size > 0) return
    if (!d.sawListener) this.finishLocal(id, d, () => d.reject(Error(NO_RECEIVER)))
    else if (d.closed) this.finishLocal(id, d, () => d.reject(Error(PORT_CLOSED)))
    else this.finishLocal(id, d, () => d.resolve(undefined))
  }

  finishLocal(id, d, settle) {
    clearTimeout(d.timer)
    this.localDeliveries.delete(id)
    settle()
    return undefined
  }

  /** The sender a message from `endpoint` carries (hub.js `senderFor`, for extension contexts). */
  senderFor(endpoint) {
    const url = endpoint.registration.url
    const sender = { id: `kimochi-${this.engine}`, url, origin: originOf(url) }
    if (endpoint.registration.kind === 'background') {
      sender.url = `${this.origin}/${this.descriptor.background.script}`
      sender.origin = this.origin
      return sender
    }
    sender.documentId = endpoint.info?.documentId
    sender.documentLifecycle = 'active'
    sender.frameId = endpoint.info?.frameId ?? 0
    return sender
  }

  /**
   * The hub takes the first answer to a message and drops the rest, so a second full answer from
   * this document is only weight on the relay: Hachidori's background answers a content script's
   * lookup with the same result its offscreen document already sent (it relays engine requests),
   * each a copy of the whole entry list. Later ones go as "answered elsewhere".
   */
  firstAnswer(args) {
    if (args.status !== 'response' && args.status !== 'error') return args
    if (this.answered.has(args.id)) return { id: args.id, status: 'unanswered' }
    this.answered.set(args.id, true)
    if (this.answered.size > ANSWERED_KEPT) this.answered.delete(this.answered.keys().next().value)
    return args
  }

  /** The kind of a child frame, from its URL rather than its own claim. */
  childKind(url) {
    let path = ''
    try {
      path = new URL(url).pathname
    } catch {
      return 'page'
    }
    if (path === '/__kimochi/ext-background.html') return 'background'
    if (this.descriptor.offscreen && path === `/${this.descriptor.offscreen}`) return 'offscreen'
    return 'page'
  }

  isOwnFrame(source) {
    for (let i = 0; i < this.win.frames.length; i += 1) if (this.win.frames[i] === source) return true
    return false
  }

  /** Accept extension frames that say hello (see the handshake above). */
  acceptChildren() {
    this.win.addEventListener(
      'message',
      (event) => {
        const data = event.data
        if (!data || typeof data !== 'object' || data.__kimochiExt !== 'hello') return
        event.stopImmediatePropagation()
        const port = event.ports?.[0]
        if (event.origin !== this.origin || !this.isOwnFrame(event.source) || !port || data.engine !== this.engine) {
          this.report({ check: 'ext-host-frame-refused', origin: event.origin, engine: data.engine, ownFrame: this.isOwnFrame(event.source) })
          port?.close?.()
          return
        }
        this.adoptChild(port, data)
      },
      true
    )
  }

  adoptChild(port, hello) {
    const kind = this.childKind(hello.url)
    const frame = `${kind}:${safePath(hello.url)}`
    const endpoint = this.attach(
      { kind, url: String(hello.url), documentId: String(hello.documentId ?? ''), top: false },
      (event) => port.postMessage({ t: 'event', event })
    )
    let budget = LOG_BUDGET_PER_MINUTE
    let windowStart = Date.now()
    const fetches = new Map()
    port.onmessage = ({ data }) => {
      if (!data || typeof data !== 'object') return
      if (data.t === 'bye') {
        for (const controller of fetches.values()) controller.abort()
        endpoint.detach()
        port.close()
        return
      }
      if (data.t === 'fetch') {
        const controller = new AbortController()
        fetches.set(data.id, controller)
        void this.network.serve(data, port, controller.signal, frame).finally(() => fetches.delete(data.id))
        return
      }
      if (data.t === 'fetch-abort') {
        fetches.get(data.id)?.abort()
        return
      }
      if (data.t === 'save') {
        const answer = (ok, value) => port.postMessage(ok ? { t: 'reply', id: data.id, ok, value } : { t: 'reply', id: data.id, ok, error: value })
        if (kind !== 'page' || typeof this.save !== 'function' || Object.prototype.toString.call(data.bytes) !== '[object ArrayBuffer]') {
          answer(false, 'Saving files is not available here')
          return
        }
        Promise.resolve()
          .then(() => this.save(String(data.name ?? 'download'), data.bytes))
          .then((value) => answer(true, json(value ?? null)), (error) => answer(false, describe(error)))
        return
      }
      if (data.t !== 'call') return
      const reply = (ok, value) => port.postMessage(ok ? { t: 'reply', id: data.id, ok, value } : { t: 'reply', id: data.id, ok, error: value })
      if (data.op === 'log') {
        if (Date.now() - windowStart > 60000) {
          windowStart = Date.now()
          budget = LOG_BUDGET_PER_MINUTE
        }
        if (budget-- > 0) this.report({ ...data.args?.value, kind, frame })
        else if (budget === -1) this.report({ check: 'ext-host-log-throttled', kind, frame })
        reply(true, undefined)
        return
      }
      endpoint.call(data.op, data.args).then(
        (value) => reply(true, value),
        (error) => reply(false, describe(error))
      )
    }
    port.start?.()
    port.postMessage({ t: 'welcome', nonce: hello.nonce, engine: this.engine })
    this.report({ check: 'ext-host-frame-linked', kind, frame })
  }
}

function safePath(url) {
  try {
    return new URL(url).pathname
  } catch {
    return String(url)
  }
}

// ---------------------------------------------------------------- hub ↔ router in one document

export function localUpstream(hub, router) {
  const link = { label: hub.label, owns: new Set(), send: (ctx, event) => queueMicrotask(() => router.dispatch(ctx, json(event))) }
  return { instance: hub.instance, link, call: (op, args) => hub.handle(link, op, json(args)) }
}

// ---------------------------------------------------------------- relay, hub side

/**
 * Answer other windows' routers over `ext_relay`, and over the fast lane (lane.js) for those that
 * reach the hub that way: each is answered, and sent its events, the way its own calls arrive.
 */
export async function serveRelay(hub, { tauri, label, engine, report }) {
  if (!tauri?.core?.invoke) return { broadcast: async () => {} }
  const send = relaySender(tauri)
  const lane = openLane(hub.win, { engine, origin: hub.origin, label })
  // Windows whose calls come over the lane (their transport is settled at hello, links.js
  // `connectRelay`); their answers and events go back the same way.
  const viaLane = new Set()
  const post = (to, payload, overLane = viaLane.has(to)) =>
    overLane && lane.send(to, payload) ? Promise.resolve() : send(to, payload)
  const links = new Map()
  const linkFor = (from) => {
    let link = links.get(from)
    if (!link) {
      link = { label: from, owns: new Set(), send: (ctx, event) => void post(from, { kind: 'ext', engine, type: 'event', ctx, event }).catch(() => {}) }
      links.set(from, link)
    }
    return link
  }
  const onCall = (payload, from, overLane) => {
    if (payload.kind !== 'ext' || payload.type !== 'call' || typeof from !== 'string') return
    if (payload.engine !== engine) {
      report({ check: 'ext-host-relay-engine-mismatch', from, engine: payload.engine })
      return
    }
    // A hello may come either way while the window finds out which works; anything else says
    // how the window talks to the hub now.
    if (payload.op !== 'hello') {
      if (overLane) viaLane.add(from)
      else viaLane.delete(from)
    }
    hub.handle(linkFor(from), payload.op, payload.args ?? {}).then(
      (value) => post(from, { kind: 'ext', engine, type: 'reply', id: payload.id, ok: true, value: json(value) }, overLane),
      (error) => post(from, { kind: 'ext', engine, type: 'reply', id: payload.id, ok: false, error: describe(error) }, overLane)
    ).catch(() => {})
  }
  lane.listen((payload, from) => onCall(payload, from, true))
  // Answer nothing until the lane is open (or known not to be), so a window saying hello finds the
  // lane if there is one, instead of settling on the relay for as long as this hub runs.
  await lane.ready.catch(() => false)
  await listenRelay(tauri, label, (payload, from) => onCall(payload, from, false), report)
  return {
    broadcast: (payload) => send(null, { kind: 'ext', engine, ...payload }).catch(() => {})
  }
}

// ---------------------------------------------------------------- relay, client side

/**
 * A router's way to a hub in another window. Says hello until the overlay answers (windows come up
 * in an order nobody controls), then hands the router an upstream; a `ready` broadcast from a
 * different hub instance means the overlay reloaded, and everything is registered again.
 */
export function connectRelay(router, { tauri, label, engine, report, onNavigate, onSetup }) {
  const send = relaySender(tauri)
  const lane = openLane(router.win, { engine, origin: router.origin, label })
  // Whether calls go over the fast lane (lane.js): settled at each hello, by which way the hub
  // answered, and kept until the next one, so one window's calls never take two roads at once.
  let useLane = false
  const node = randomId('N')
  const pending = new Map()
  let nextId = 0
  let hubInstance = null
  let helloLoop = null
  const status = { hub: null, ready: false, error: null, lane: false }

  const rawCall = (op, args, timeoutMs, overLane = useLane) => {
    const id = ++nextId
    const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject, op }))
    const payload = { kind: 'ext', engine, type: 'call', id, op, args: json(args) }
    if (!(overLane && lane.send('overlay', payload))) {
      void send('overlay', payload).catch((error) => {
        pending.get(id)?.reject(error)
        pending.delete(id)
      })
    }
    if (!timeoutMs) return answer
    return within(answer, timeoutMs, 'The overlay did not answer').finally(() => pending.delete(id))
  }

  /** Say hello over the lane, where there is one, then over `ext_relay`; the first answer says which. */
  const helloOnce = async (timeoutMs) => {
    if (await lane.ready.catch(() => false)) {
      try {
        return { reply: await rawCall('hello', { node }, Math.min(LANE_HELLO_MS, timeoutMs), true), overLane: true }
      } catch (error) {
        // No hub on the lane (yet, or this webview keeps windows apart): the relay decides.
        report({ check: 'ext-host-lane-hello', window: label, ok: false, error: describe(error) })
      }
    }
    return { reply: await rawCall('hello', { node }, timeoutMs, false), overLane: false }
  }

  const adopt = ({ reply, overLane }) => {
    status.ready = reply.ready
    status.error = reply.error
    if (reply.setup) onSetup?.(reply.setup)
    if (reply.navigate) onNavigate?.(reply.navigate)
    // A hub the lane already reached keeps it: a relay answer from it only means a hello on the
    // lane was lost while it started (two hellos can be under way at once: the loop's and a probe's).
    const keepLane = useLane && !overLane && reply.hub === hubInstance
    if (overLane !== useLane && !keepLane) {
      useLane = overLane
      status.lane = overLane
      report({ check: 'ext-host-lane', window: label, lane: overLane })
    }
    if (reply.hub === hubInstance) return
    const restarted = hubInstance !== null
    hubInstance = reply.hub
    status.hub = reply.hub
    for (const [id, entry] of pending) {
      if (entry.op === 'hello') continue
      entry.reject(Error('The extension host in the overlay restarted'))
      pending.delete(id)
    }
    router.setUpstream({ instance: reply.hub, call: (op, args) => rawCall(op, args) })
    if (restarted) report({ check: 'ext-host-relay-rebound', hub: reply.hub })
    if (!useLane) upgrade()
  }

  /**
   * Settled on the relay while this window's own lane is open: the hub's was not yet (it opens
   * its frame as it starts, and a busy start can take seconds). Try the lane again a few times,
   * each only while no call waits on the relay, so nothing sent there is overtaken.
   */
  let upgrading = null
  const upgrade = () => {
    upgrading ??= (async () => {
      if (!(await lane.ready.catch(() => false))) return
      for (let attempt = 0; attempt < LANE_UPGRADE_TRIES && !useLane; attempt += 1) {
        await sleep(LANE_UPGRADE_MS)
        if (useLane || [...pending.values()].some((entry) => entry.op !== 'hello')) continue
        try {
          const reply = await rawCall('hello', { node }, LANE_HELLO_MS, true)
          // A hub that changed meanwhile is the hello loop's to adopt.
          if (reply.hub === hubInstance) adopt({ reply, overLane: true })
          return
        } catch {
          // Not yet: try again later.
        }
      }
    })().finally(() => (upgrading = null))
  }

  const hello = () => {
    helloLoop ??= (async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          adopt(await helloOnce(1500))
          return
        } catch {
          await sleep(Math.min(250 * 2 ** attempt, 5000))
        }
      }
    })().finally(() => (helloLoop = null))
    return helloLoop
  }

  const onReply = (payload) => {
    const entry = pending.get(payload.id)
    if (!entry) return
    pending.delete(payload.id)
    if (payload.ok) entry.resolve(payload.value)
    else entry.reject(Error(payload.error))
  }
  // From the hub over the lane: answers and events only (broadcasts and pages stay on the relay).
  lane.listen((payload, from) => {
    if (from !== 'overlay' || payload.kind !== 'ext' || payload.engine !== engine) return
    if (payload.type === 'reply') onReply(payload)
    else if (payload.type === 'event') router.dispatch(payload.ctx, payload.event)
  })

  void listenRelay(tauri, label, (payload, from) => {
    if (payload.kind === 'navigate' && from === 'overlay' && typeof payload.url === 'string') {
      onNavigate?.(payload.url)
      return
    }
    if (payload.kind !== 'ext' || payload.engine !== engine) return
    if (payload.type === 'reply') {
      onReply(payload)
    } else if (payload.type === 'event') {
      router.dispatch(payload.ctx, payload.event)
    } else if (payload.type === 'setup') {
      onSetup?.(payload.setup)
    } else if (payload.type === 'ready') {
      status.ready = true
      if (payload.hub !== hubInstance) void hello()
    } else if (payload.type === 'serving') {
      // A hub has just started listening: say hello now rather than at the next backoff step.
      if (payload.hub !== hubInstance) void hello()
    }
  }, report).then(() => hello())

  return {
    status,
    hello,
    /** Ask the hub whether the engine is up (and adopt it if it is a new hub). */
    async probe(timeoutMs = 1500) {
      const answer = await helloOnce(timeoutMs)
      adopt(answer)
      return answer.reply
    }
  }
}

// ---------------------------------------------------------------- child frame side

/**
 * The upstream of an extension frame: one MessagePort to its parent, handed over in the hello.
 * Calls made before the parent answers wait for it; with no host above (a page opened on its own)
 * they fail after a bounded wait, saying so.
 */
export function connectToParent(win, { engine, kind, documentId, onEvent, onFetchFrame }) {
  const channel = new win.MessageChannel()
  const port = channel.port1
  const nonce = randomId('N')
  const pending = new Map()
  let nextId = 0
  let resolveLinked
  let rejectLinked
  const linked = new Promise((resolve, reject) => {
    resolveLinked = resolve
    rejectLinked = reject
  })
  linked.catch(() => {})
  const timer = setTimeout(() => rejectLinked(Error('No Kimochi extension host answered this frame')), CHILD_WELCOME_MS)
  port.onmessage = ({ data }) => {
    if (!data || typeof data !== 'object') return
    if (data.t === 'welcome') {
      if (data.nonce !== nonce) return
      clearTimeout(timer)
      resolveLinked()
    } else if (data.t === 'reply') {
      const entry = pending.get(data.id)
      if (!entry) return
      pending.delete(data.id)
      if (data.ok) entry.resolve(data.value)
      else entry.reject(Error(data.error))
    } else if (data.t === 'event') onEvent(data.event)
    else if (typeof data.t === 'string' && data.t.startsWith('fetch-')) onFetchFrame?.(data)
  }
  port.start?.()
  if (win.parent && win.parent !== win) {
    const target = win.location.ancestorOrigins?.[0] ?? '*'
    win.parent.postMessage(
      { __kimochiExt: 'hello', v: 1, engine, nonce, kind, url: win.location.href, documentId },
      target,
      [channel.port2]
    )
  } else {
    clearTimeout(timer)
    rejectLinked(Error('This extension page is not inside a Kimochi window, so it has no extension host'))
  }
  win.addEventListener('pagehide', () => port.postMessage({ t: 'bye' }))
  return {
    linked,
    port,
    async call(op, args = {}) {
      await linked
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        port.postMessage({ t: 'call', id, op, args: json(args) })
      })
    },
    post(message, transfer) {
      void linked.then(() => port.postMessage(message, transfer ?? []))
    },
    /** Hand a downloaded file's bytes (transferred) to the window to save (page.js). */
    async save(name, bytes) {
      await linked
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        port.postMessage({ t: 'save', id, name: String(name), bytes }, [bytes])
      })
    }
  }
}

// ---------------------------------------------------------------- extension window side

/**
 * The label of the hidden extension window this document is the top document of (`ext-<engine>`,
 * from native's label prelude), or null. Only such a document reaches the hub over the relay
 * itself; every other extension document hops to its parent by postMessage.
 */
export function extensionWindowLabel(win, engine) {
  if (win !== win.top) return null
  const label = win.__kimochiPanelLabel
  if (label !== `ext-${engine}`) return null
  if (!win.__TAURI__?.core?.invoke || !win.__TAURI__?.event?.listen) return null
  return label
}

/**
 * The upstream of a context that is the top document of an extension window: a Router of its own
 * (which also adopts the window's child frames, the offscreen document, exactly as an app window's
 * Router adopts its extension iframes), relayed to the overlay's hub over `ext_relay`. Same shape
 * as `connectToParent`: `{linked, call, post}`; `post` is unused here (this document fetches
 * through plugin-http itself, see network.js `installDirectNetwork`).
 */
export function connectViaRelay(win, { engine, descriptor, origin, label, kind, documentId, report, network, onEvent }) {
  const router = new Router({ win, engine, descriptor, origin, label, report, network })
  router.acceptChildren()
  const relay = connectRelay(router, { tauri: extTauri(win), label, engine, report })
  const endpoint = router.attach({ kind, url: win.location.href, documentId, top: true }, onEvent)
  win.addEventListener('pagehide', () => endpoint.detach())
  const linked = endpoint.registered.then(() => undefined)
  linked.catch(() => {})
  return {
    linked,
    router,
    relay,
    call: (op, args = {}) => endpoint.call(op, args),
    post() {}
  }
}
