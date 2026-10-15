/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Transports between contexts and the hub (DICTIONARY_ENGINES.md §5.2).
 *
 *   extension iframe ──postMessage + MessagePort──▶ its parent's Router
 *   Router (overlay / harness) ──direct calls──▶ Hub
 *   Router (log, dictionary panel, welcome) ──Tauri ext_relay──▶ Hub's relay server
 *   Router (extension window: background + its offscreen iframe) ──Tauri ext_relay──▶ Hub
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
import { listenRelay as listenSharedRelay } from './primitives.js'
import { describe, json, randomId, sleep, within } from './util.js'

const CHILD_WELCOME_MS = 30000
const LOG_BUDGET_PER_MINUTE = 120

/** One serialised `ext_relay` sender per document. */
function relaySender(tauri) {
  const chains = new Map()
  return (target, payload) => {
    const key = target ?? '*'
    const next = (chains.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => tauri.core.invoke('ext_relay', { target, payload }))
    chains.set(key, next)
    return next
  }
}

/** Listen to `ext-relay` with the shared address filter and per-sender de-duplication. */
const listenRelay = (tauri, label, onPayload, report) =>
  listenSharedRelay(tauri, label, onPayload, (from, seq) => report({ check: 'ext-host-relay-duplicate', from, seq }))

// ---------------------------------------------------------------- Router

export class Router {
  constructor({ win, engine, descriptor, origin, label, report, network }) {
    this.win = win
    this.engine = engine
    this.descriptor = descriptor
    this.origin = origin
    this.label = label
    this.report = report
    this.network = network
    this.endpoints = new Map()
    this.byHub = new Map()
    this.nextLocal = 0
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
        if (endpoint.hubCtx !== null) {
          this.byHub.delete(endpoint.hubCtx)
          void this.upstream?.call('unregister', { ctx: endpoint.hubCtx }).catch(() => {})
        }
      }
    }
  }

  dispatch(hubCtx, event) {
    const endpoint = this.endpoints.get(this.byHub.get(hubCtx))
    if (endpoint) endpoint.onEvent(event)
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

/** Answer other windows' routers over `ext_relay`. */
export async function serveRelay(hub, { tauri, label, engine, report }) {
  if (!tauri?.core?.invoke) return { broadcast: async () => {} }
  const send = relaySender(tauri)
  const links = new Map()
  const linkFor = (from) => {
    let link = links.get(from)
    if (!link) {
      link = { label: from, owns: new Set(), send: (ctx, event) => void send(from, { kind: 'ext', engine, type: 'event', ctx, event }).catch(() => {}) }
      links.set(from, link)
    }
    return link
  }
  await listenRelay(tauri, label, (payload, from) => {
    if (payload.kind !== 'ext' || payload.type !== 'call' || typeof from !== 'string') return
    if (payload.engine !== engine) {
      report({ check: 'ext-host-relay-engine-mismatch', from, engine: payload.engine })
      return
    }
    hub.handle(linkFor(from), payload.op, payload.args ?? {}).then(
      (value) => send(from, { kind: 'ext', engine, type: 'reply', id: payload.id, ok: true, value: json(value) }),
      (error) => send(from, { kind: 'ext', engine, type: 'reply', id: payload.id, ok: false, error: describe(error) })
    ).catch(() => {})
  }, report)
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
  const node = randomId('N')
  const pending = new Map()
  let nextId = 0
  let hubInstance = null
  let helloLoop = null
  const status = { hub: null, ready: false, error: null }

  const rawCall = (op, args, timeoutMs) => {
    const id = ++nextId
    const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject, op }))
    void send('overlay', { kind: 'ext', engine, type: 'call', id, op, args: json(args) }).catch((error) => {
      pending.get(id)?.reject(error)
      pending.delete(id)
    })
    if (!timeoutMs) return answer
    return within(answer, timeoutMs, 'The overlay did not answer').finally(() => pending.delete(id))
  }

  const adopt = (reply) => {
    status.ready = reply.ready
    status.error = reply.error
    if (reply.setup) onSetup?.(reply.setup)
    if (reply.navigate) onNavigate?.(reply.navigate)
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
  }

  const hello = () => {
    helloLoop ??= (async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          adopt(await rawCall('hello', { node }, 1500))
          return
        } catch {
          await sleep(Math.min(250 * 2 ** attempt, 5000))
        }
      }
    })().finally(() => (helloLoop = null))
    return helloLoop
  }

  void listenRelay(tauri, label, (payload, from) => {
    if (payload.kind === 'navigate' && from === 'overlay' && typeof payload.url === 'string') {
      onNavigate?.(payload.url)
      return
    }
    if (payload.kind !== 'ext' || payload.engine !== engine) return
    if (payload.type === 'reply') {
      const entry = pending.get(payload.id)
      if (!entry) return
      pending.delete(payload.id)
      if (payload.ok) entry.resolve(payload.value)
      else entry.reject(Error(payload.error))
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
      const reply = await rawCall('hello', { node }, timeoutMs)
      adopt(reply)
      return reply
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
  const relay = connectRelay(router, { tauri: win.__TAURI__, label, engine, report })
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
