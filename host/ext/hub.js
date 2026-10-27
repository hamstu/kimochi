/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * The hub (DICTIONARY_ENGINES.md §5.2): one per engine session, in the overlay's top document (or
 * the browser harness). The background and offscreen documents it waits for run in the engine's
 * hidden extension window (`ext-<id>`) and register over the relay like any other window. It owns the context table, the storage areas, message routing and ports;
 * every context reaches it through `handle(link, op, args)`, whatever transport carried the call.
 *
 * A `link` is how the hub talks back to the contexts that registered through it:
 * `{label, owns: Set<ctx>, send(ctx, event)}`. Local contexts (this document, its iframes) share
 * the router's link; each other window has one relay link.
 */
import { captureArgs, encodeFrame } from './capture.js'
import { ENGINES } from './engines.js'
import { selectStorage, storageChanges } from './primitives.js'
import { NO_RECEIVER, PORT_CLOSED, describe, json, originOf, randomId, sleep, tabIdFor, within } from './util.js'

/** `storage_load` tries before a session gives up on the file and runs without writing it. */
const LOAD_ATTEMPTS = 3
const LOAD_RETRY_MS = 200
const EXTENSION_KINDS = new Set(['background', 'offscreen', 'page'])
/** A target that never says whether it has listeners is treated as having none after this. */
const DELIVERY_ACK_MS = 10000
const OFFSCREEN_WAIT_MS = 30000
/** Chrome's prefix for every capture failure; Hachidori shows what follows to the reader. */
const CAPTURE_FAILED = 'Failed to capture tab'

export class Hub {
  constructor({ engine, origin, label = 'overlay', invoke, report, openLocally, win = window, encode = null }) {
    this.engine = engine
    this.descriptor = ENGINES[engine]
    this.origin = origin
    this.label = label
    this.invoke = invoke
    this.report = report
    this.openLocally = openLocally
    this.win = win
    this.encode = encode ?? ((url, options) => encodeFrame(win, url, options))
    /** The content context that last messaged the extension: the "active tab" a capture shows. */
    this.activeContent = null
    this.instance = randomId('H')
    this.runtimeId = `kimochi-${engine}`
    this.contexts = new Map()
    this.deliveries = new Map()
    this.ports = new Map()
    this.store = { local: {}, sync: {}, session: {} }
    this.hostState = {}
    this.nextContext = 0
    this.nextDelivery = 0
    this.waiters = new Set()
    this.saveChain = Promise.resolve()
    this.pendingSave = null
    /** Why the storage file could not be read; while set, this session never writes the file. */
    this.storageUnreadable = null
    this.lastOpen = null
    this.engineReady = false
    this.engineError = null
    this.installAnswered = false
    this.failure = null
  }

  // ---------------------------------------------------------------- storage file

  /**
   * `chrome-local-<id>.json` holds `{local, sync, host}`: `sync` is a key space inside the same
   * file (§5.3), `host` is this host's own bookkeeping (the install record), invisible to the
   * extension. `storage_load` answers `{}` when the file does not exist, which is the only time
   * the descriptor's `storageSeed` is applied; the seeded file is written at once so a launch that
   * never writes cannot seed twice.
   *
   * A load that *fails* is not a missing file: the file may list every installed dictionary and
   * only this read went wrong. Seeding and saving then (as an earlier build did) replaced the
   * user's file with an empty one. So a failed load is retried, and if it still fails the session
   * runs on the seed in memory and never writes the file (`persist` stands down). Native already
   * recovers a corrupt file from its previous good copy (`storage_load`), so this is for a read
   * that could not be answered at all.
   */
  async loadStorage() {
    let file = null
    let failure = null
    for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
      try {
        file = (await this.invoke('storage_load', { extension: this.engine })) ?? {}
        failure = null
        break
      } catch (error) {
        failure = error
        if (attempt < LOAD_ATTEMPTS) await sleep(LOAD_RETRY_MS * attempt)
      }
    }
    const seed = this.descriptor.storageSeed ?? {}
    if (failure) {
      this.storageUnreadable = describe(failure)
      this.store.local = json(seed.local ?? {})
      this.store.sync = json(seed.sync ?? {})
      this.hostState = {}
      this.report({ check: 'ext-host-storage-load-failed', engine: this.engine, action: 'read-only', error: this.storageUnreadable })
      return
    }
    const fresh = !file || typeof file !== 'object' || !('local' in file)
    if (fresh) {
      this.store.local = json(seed.local ?? {})
      this.store.sync = json(seed.sync ?? {})
      this.hostState = {}
      await this.persist().catch(() => {})
      this.report({ check: 'ext-host-storage-seeded', seed: Object.keys(seed) })
    } else {
      this.store.local = file.local ?? {}
      this.store.sync = file.sync ?? {}
      this.hostState = file.host ?? {}
    }
  }

  /**
   * Writes coalesce: a write that arrives while one is in flight rides the next save. After a
   * failed load nothing is written (`loadStorage`): memory holds a stand-in, the file is the user's.
   */
  persist() {
    if (this.storageUnreadable) return Promise.resolve()
    if (!this.pendingSave) {
      const next = this.saveChain.catch(() => {}).then(() => {
        this.pendingSave = null
        return this.invoke('storage_save', {
          extension: this.engine,
          value: { local: this.store.local, sync: this.store.sync, host: this.hostState }
        })
      })
      this.pendingSave = next
      this.saveChain = next
    }
    return this.pendingSave
  }

  // ---------------------------------------------------------------- contexts

  context(id) {
    const rec = this.contexts.get(id)
    if (!rec) throw Error(`Unknown extension context ${id}`)
    return rec
  }

  senderFor(rec) {
    const sender = { id: this.runtimeId, url: rec.url, origin: safeOrigin(rec.url) }
    if (rec.kind === 'background') {
      // A service worker's sender is its script URL. Hachidori's offscreen document accepts engine
      // configuration only from exactly that (offscreen.js, `expectedBackgroundUrl`), so the host
      // page's own URL would never do.
      sender.url = `${this.origin}/${this.descriptor.background.script}`
      sender.origin = this.origin
      return sender
    }
    sender.documentId = rec.documentId
    sender.documentLifecycle = 'active'
    sender.frameId = rec.frameId
    if (rec.kind === 'content') sender.tab = this.tab(rec.tabId)
    return sender
  }

  tabs() {
    const byTab = new Map([[1, { id: 1, url: this.win.location.href, label: this.label }]])
    for (const rec of this.contexts.values()) {
      if (rec.kind !== 'content') continue
      if (rec.tabId === 1 || !byTab.has(rec.tabId)) byTab.set(rec.tabId, { id: rec.tabId, url: rec.url, label: rec.label })
    }
    return [...byTab.values()].map((t, index) => ({
      id: t.id,
      index,
      windowId: 1,
      active: true,
      highlighted: true,
      selected: true,
      pinned: false,
      audible: false,
      discarded: false,
      autoDiscardable: false,
      incognito: false,
      groupId: -1,
      status: 'complete',
      url: t.url,
      title: t.label === 'overlay' ? 'Kimochi' : `Kimochi ${t.label}`,
      width: this.win.innerWidth || 0,
      height: this.win.innerHeight || 0
    }))
  }

  tab(tabId) {
    return this.tabs().find((t) => t.id === tabId) ?? { id: tabId, index: 0, windowId: 1, active: true, url: '', incognito: false }
  }

  window(populate) {
    const win = { id: 1, focused: true, top: 0, left: 0, width: this.win.innerWidth || 0, height: this.win.innerHeight || 0, incognito: false, type: 'normal', state: 'normal', alwaysOnTop: false }
    if (populate) win.tabs = this.tabs()
    return win
  }

  register(link, args) {
    const id = ++this.nextContext
    const kind = args.kind
    const label = link.label ?? args.label ?? this.label
    const rec = {
      id,
      kind,
      label,
      link,
      url: String(args.url ?? ''),
      documentId: args.documentId || randomId(),
      tabId: kind === 'content' ? tabIdFor(label) : undefined,
      frameId: kind === 'content' && !args.top ? id : 0,
      // A background/offscreen document announces `ready` once its scripts have run; one that
      // re-registers with a restarted hub (it stayed up in the extension window) brings it along.
      ready: !['background', 'offscreen'].includes(kind) || args.ready === true
    }
    this.contexts.set(id, rec)
    link.owns.add(id)
    this.wake()
    return { ctx: id, tabId: rec.tabId, frameId: rec.frameId, documentId: rec.documentId }
  }

  unregister(id) {
    const rec = this.contexts.get(id)
    if (!rec) return
    this.contexts.delete(id)
    rec.link.owns.delete(id)
    for (const [deliveryId, d] of this.deliveries) {
      if (d.initial.delete(id) || (d.pending.delete(id) && (d.closed = true))) this.check(deliveryId, d)
    }
    for (const port of [...this.ports.values()]) {
      if (port.opener === id) this.closePortFrom(port, id, false)
      else if (port.receivers.has(id)) this.closePortFrom(port, id, false)
    }
    if (rec.kind === 'background' || rec.kind === 'offscreen') {
      this.report({ check: 'ext-host-context-gone', kind: rec.kind, url: rec.url })
    }
    this.wake()
  }

  /** Every context a link registered goes when its window or frame does. */
  dropLink(link) {
    for (const id of [...link.owns]) this.unregister(id)
  }

  wake() {
    for (const waiter of [...this.waiters]) waiter()
  }

  /** Resolve once `predicate()` is truthy, re-checked whenever the context table changes. */
  until(predicate, ms, message) {
    let value
    try {
      value = predicate()
    } catch (error) {
      return Promise.reject(error)
    }
    if (value) return Promise.resolve(value)
    let waiter
    return within(
      new Promise((resolve, reject) => {
        waiter = () => {
          try {
            const v = predicate()
            if (v) resolve(v)
          } catch (error) {
            reject(error)
          }
        }
        this.waiters.add(waiter)
      }),
      ms,
      message
    ).finally(() => this.waiters.delete(waiter))
  }

  readyContext(kind) {
    return [...this.contexts.values()].find((rec) => rec.kind === kind && rec.ready)
  }

  // ---------------------------------------------------------------- calls

  async handle(link, op, args = {}) {
    if (op === 'register') return this.register(link, args)
    if (op === 'hello') return this.hello(link, args)
    if (op === 'status') return this.status()
    // Asked by windows with no context of their own (the dictionary panel's "open settings").
    if (op === 'open' && args.ctx === undefined) return this.open(args.url)
    const ctx = args.ctx
    if (!link.owns.has(ctx)) throw Error(`Extension context ${ctx} is not registered through this link`)
    const rec = this.context(ctx)
    switch (op) {
      case 'unregister':
        return this.unregister(ctx)
      case 'ready':
        rec.ready = true
        this.wake()
        return true
      case 'failed':
        // The background script did not load: say so now rather than after the start timeout.
        this.failure = `${rec.kind} failed: ${args.error}`
        this.wake()
        return true
      case 'sendMessage':
        if (rec.kind === 'offscreen') this.observeMessage?.(args.message)
        if (rec.kind === 'content') {
          this.activeContent = ctx
          rec.captureHint = args.capture ?? null
        }
        await this.backgroundAwake(ctx)
        return this.deliver(this.extensionTargets(ctx), args.message, this.senderFor(rec))
      case 'tabsSendMessage':
        return this.deliver(this.contentTargets(args.tabId, args.options ?? {}), args.message, this.senderFor(rec))
      case 'delivered':
        return this.delivered(ctx, args)
      case 'connect':
        if (args.tabId === undefined || args.tabId === null) await this.backgroundAwake(ctx)
        return this.connect(rec, args)
      case 'portPost':
        return this.portPost(ctx, args)
      case 'portClose': {
        const port = this.ports.get(args.port)
        if (port) this.closePortFrom(port, ctx, args.noListener === true)
        return undefined
      }
      case 'storage':
        return this.storage(args)
      case 'tabs':
        return this.tabsCall(args)
      case 'captureVisibleTab':
        return this.captureVisibleTab(args)
      case 'windows':
        return args.action === 'getAll' ? [this.window(args.args?.[0]?.populate)] : this.window(args.args?.[1]?.populate)
      case 'getContexts':
        return this.getContexts(args.filter ?? {})
      case 'offscreen':
        return this.offscreen(args)
      case 'open':
        return this.open(args.url)
      case 'install':
        return this.install()
      case 'persistenceClaims':
        return this.persistenceClaims()
      case 'persistenceReport':
        return this.reconcilePersistence(args)
      case 'log':
        return this.report({ ...args.value, kind: rec.kind, frame: rec.url })
      default:
        throw Error(`Unknown extension host call ${op}`)
    }
  }

  hello(link, args) {
    // A window that reloaded says hello as a new node; whatever it registered before is gone.
    if (args.node && link.node && link.node !== args.node) this.dropLink(link)
    if (args.node) link.node = args.node
    let navigate = null
    if (link.label === 'dictionary' && this.lastOpen && Date.now() - this.lastOpen.at < 60000) {
      navigate = this.lastOpen.url
      this.lastOpen = null
    }
    return { hub: this.instance, engine: this.engine, ready: this.engineReady, error: this.engineError, setup: this.setup, navigate }
  }

  status() {
    const state = (kind) => {
      const rec = [...this.contexts.values()].find((r) => r.kind === kind)
      return rec ? (rec.ready ? 'ready' : 'loading') : 'absent'
    }
    return { hub: this.instance, engine: this.engine, ready: this.engineReady, error: this.engineError, background: state('background'), offscreen: this.descriptor.offscreen ? state('offscreen') : 'not-used' }
  }

  /**
   * Chrome wakes a service worker for a message and delivers it once the worker has evaluated, so
   * a message sent while our background page is still loading its script waits for it instead of
   * finding no listener. (Hachidori's offscreen.js asks the background for its engine config at
   * module load, `readEngineConfig`, racing the background script in a fresh session.)
   */
  async backgroundAwake(from) {
    const caller = this.context(from)
    if (caller.kind === 'background') return
    // Native can open settings before the hidden engine window has even registered. Pages
    // also need the offscreen listeners: otherwise their first status request sticks at empty.
    // Offscreen itself must only wait for the background, or its config request deadlocks.
    await this.until(() => {
      if (this.failure) throw Error(this.failure)
      return this.readyContext('background') &&
        (caller.kind !== 'page' || !this.descriptor.offscreen || this.readyContext('offscreen'))
    }, OFFSCREEN_WAIT_MS, 'The extension message receivers did not start')
  }

  extensionTargets(from) {
    return [...this.contexts.values()].filter((rec) => rec.id !== from && EXTENSION_KINDS.has(rec.kind))
  }

  /**
   * Content contexts of a tab. `frameId: undefined` means every frame (10ten's `enableTab` passes
   * `{frameId: sender.frameId}`, which is undefined when it enables a whole tab); 10ten also names
   * the target inside the message (`frame: '*' | 'top' | n`), which its own listener filters on.
   */
  contentTargets(tabId, options) {
    return [...this.contexts.values()].filter(
      (rec) =>
        rec.kind === 'content' &&
        rec.tabId === tabId &&
        (options.frameId === undefined || options.frameId === null || rec.frameId === options.frameId) &&
        (!options.documentId || rec.documentId === options.documentId)
    )
  }

  /**
   * Chrome's `sendMessage` aggregation: every target runs its listeners; the first answer wins;
   * targets that only had silent listeners make it resolve `undefined`; no listener anywhere is
   * `NO_RECEIVER`, the exact text Hachidori's relay retries on.
   */
  deliver(targets, message, sender) {
    if (targets.length === 0) return Promise.reject(Error(NO_RECEIVER))
    const id = ++this.nextDelivery
    return new Promise((resolve, reject) => {
      const d = { resolve, reject, initial: new Set(targets.map((t) => t.id)), pending: new Set(), sawListener: false, closed: false }
      d.timer = setTimeout(() => {
        if (d.initial.size === 0) return
        this.report({ check: 'ext-host-delivery-unacknowledged', contexts: [...d.initial] })
        d.initial.clear()
        this.check(id, d)
      }, DELIVERY_ACK_MS)
      this.deliveries.set(id, d)
      for (const target of targets) target.link.send(target.id, { type: 'deliver', id, message, sender })
    })
  }

  delivered(ctx, { id, status, value, error }) {
    const d = this.deliveries.get(id)
    if (!d) return undefined
    if (status === 'response') return this.finish(id, d, () => d.resolve(value))
    if (status === 'error') return this.finish(id, d, () => d.reject(Error(error)))
    if (status === 'pending') {
      d.initial.delete(ctx)
      d.pending.add(ctx)
      d.sawListener = true
    } else if (status === 'unanswered') {
      d.initial.delete(ctx)
      d.sawListener = true
    } else if (status === 'none') d.initial.delete(ctx)
    this.check(id, d)
    return undefined
  }

  check(id, d) {
    if (d.initial.size > 0 || d.pending.size > 0) return
    if (!d.sawListener) this.finish(id, d, () => d.reject(Error(NO_RECEIVER)))
    else if (d.closed) this.finish(id, d, () => d.reject(Error(PORT_CLOSED)))
    else this.finish(id, d, () => d.resolve(undefined))
  }

  finish(id, d, settle) {
    clearTimeout(d.timer)
    this.deliveries.delete(id)
    settle()
  }

  // ---------------------------------------------------------------- ports

  connect(opener, { port: id, name, tabId, frameId, documentId }) {
    const targets = tabId === undefined || tabId === null
      ? this.extensionTargets(opener.id)
      : this.contentTargets(tabId, { frameId, documentId })
    const port = { id, name, opener: opener.id, receivers: new Set(targets.map((t) => t.id)), accepted: false }
    if (targets.length === 0) {
      opener.link.send(opener.id, { type: 'port-close', port: id, error: NO_RECEIVER })
      return undefined
    }
    this.ports.set(id, port)
    const sender = this.senderFor(opener)
    for (const target of targets) target.link.send(target.id, { type: 'port-open', port: id, name, sender })
    return undefined
  }

  portPost(ctx, { port: id, message }) {
    const port = this.ports.get(id)
    if (!port) throw Error('Attempting to use a disconnected port object')
    if (ctx === port.opener) {
      for (const receiver of port.receivers) this.contexts.get(receiver)?.link.send(receiver, { type: 'port-message', port: id, message })
    } else if (port.receivers.has(ctx)) {
      port.accepted = true
      this.contexts.get(port.opener)?.link.send(port.opener, { type: 'port-message', port: id, message })
    }
    return undefined
  }

  closePortFrom(port, ctx, noListener) {
    if (ctx === port.opener) {
      this.ports.delete(port.id)
      for (const receiver of port.receivers) this.contexts.get(receiver)?.link.send(receiver, { type: 'port-close', port: port.id })
      return
    }
    if (!port.receivers.delete(ctx)) return
    if (!noListener) port.accepted = true
    if (port.receivers.size > 0) return
    this.ports.delete(port.id)
    this.contexts.get(port.opener)?.link.send(port.opener, { type: 'port-close', port: port.id, error: port.accepted ? undefined : NO_RECEIVER })
  }

  // ---------------------------------------------------------------- storage

  async storage({ area, action, keys, values }) {
    if (!['local', 'sync', 'session'].includes(area)) throw Error(`storage.${area} is not available`)
    const data = this.store[area]
    const select = (wanted) => selectStorage(data, wanted, json)
    switch (action) {
      case 'get':
        return select(keys)
      case 'getKeys':
        return Object.keys(data)
      case 'getBytesInUse': {
        const chosen = keys === null || keys === undefined ? data : select(Array.isArray(keys) || typeof keys === 'string' ? keys : Object.keys(keys))
        return new TextEncoder().encode(JSON.stringify(chosen)).length
      }
      case 'set':
        return this.mutate(area, (store) => Object.assign(store, json(values ?? {})))
      case 'remove':
        return this.mutate(area, (store) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]
        })
      case 'clear':
        return this.mutate(area, (store) => {
          for (const k of Object.keys(store)) delete store[k]
        })
      default:
        throw Error(`Unknown storage action ${action}`)
    }
  }

  /**
   * Apply in memory (later reads see it at once), persist `local`/`sync`, then tell every context.
   * A failed save is reported and rejects the write, but memory is not rolled back: other writes
   * may already have been layered on top, and the next save carries everything.
   */
  async mutate(area, fn) {
    const previous = json(this.store[area])
    fn(this.store[area])
    const changes = storageChanges(previous, this.store[area], json)
    let failure = null
    if (area !== 'session' && Object.keys(changes).length > 0) {
      try {
        await this.persist()
      } catch (error) {
        failure = error
        this.report({ check: 'ext-host-storage-save-failed', area, error: describe(error) })
      }
    }
    if (Object.keys(changes).length > 0) {
      for (const rec of this.contexts.values()) rec.link.send(rec.id, { type: 'storage-changed', area, changes })
    }
    if (failure) throw failure
    return undefined
  }

  // ---------------------------------------------------------------- tabs, contexts, offscreen

  tabsCall({ action, args = [] }) {
    if (action === 'query') {
      const query = args[0] ?? {}
      if (query.active === false || query.highlighted === false) return []
      return this.tabs().filter(() => query.windowId === undefined || query.windowId === 1 || query.windowId === -2)
    }
    if (action === 'get') {
      const found = this.tabs().find((t) => t.id === args[0])
      if (!found) throw Error(`No tab with id: ${args[0]}.`)
      return found
    }
    throw Error(`tabs.${action} is not available`)
  }

  /**
   * `tabs.captureVisibleTab`: the captured source frame, not the overlay (capture.js). The tab
   * is the content context that last messaged the extension (the window the lookup was made in);
   * from the Log, the transcript line's scan names the frame it was read from, which native
   * still holds for recent lines and otherwise replaces with the frame on screen now. Before
   * anything was captured this fails with Chrome's prefix, and Hachidori adds the note without
   * its picture.
   */
  async captureVisibleTab({ windowId, options }) {
    const { format, quality } = captureArgs(windowId, options)
    const started = Date.now()
    const rec = this.contexts.get(this.activeContent)
    const scan = rec?.captureHint?.scan ?? null
    const fail = (why) => {
      this.report({ check: 'ext-host-capture', ok: false, error: why, tab: rec?.tabId ?? null, scan })
      return Error(`${CAPTURE_FAILED}: ${why}`)
    }
    for (let attempt = 1; ; attempt += 1) {
      let source
      try {
        source = await this.invoke('capture_frame_source', { scan })
      } catch (error) {
        throw fail(describe(error))
      }
      if (!source?.url) throw fail('Kimochi has not captured your source yet. Scan once, then add the card again.')
      // Held for the fetch, so a newer probe cannot evict it in between (best effort: a full
      // retention table answers false, and the retry below covers the gap).
      const held = await this.invoke('retain_frame', { id: source.id, retain: true }).catch(() => false)
      try {
        const dataUrl = await this.encode(source.url, { format, quality })
        this.report({
          check: 'ext-host-capture',
          ok: true,
          frame: source.id,
          matched: Boolean(source.matched),
          tab: rec?.tabId ?? null,
          scan,
          format,
          quality,
          bytes: dataUrl.length,
          ms: Date.now() - started
        })
        return dataUrl
      } catch (error) {
        if (!(error?.gone && attempt < 2)) throw fail(describe(error))
      } finally {
        if (held) void this.invoke('retain_frame', { id: source.id, retain: false }).catch(() => {})
      }
    }
  }

  getContexts(filter) {
    const out = []
    for (const rec of this.contexts.values()) {
      let entry
      if (rec.kind === 'offscreen' && rec.ready) {
        entry = { contextType: 'OFFSCREEN_DOCUMENT', tabId: -1, windowId: -1, frameId: 0, documentId: rec.documentId, documentUrl: rec.url, documentOrigin: safeOrigin(rec.url) }
      } else if (rec.kind === 'page') {
        entry = { contextType: 'TAB', tabId: tabIdFor(rec.label), windowId: 1, frameId: 0, documentId: rec.documentId, documentUrl: rec.url, documentOrigin: safeOrigin(rec.url) }
      } else if (rec.kind === 'background' && rec.ready) {
        entry = { contextType: 'BACKGROUND', tabId: -1, windowId: -1, frameId: -1 }
      } else continue
      entry.contextId = rec.documentId ?? `ctx-${rec.id}`
      entry.incognito = false
      out.push(entry)
    }
    const matches = (list, value) => !Array.isArray(list) || list.length === 0 || list.includes(value)
    return out.filter(
      (c) =>
        matches(filter.contextTypes, c.contextType) &&
        matches(filter.documentUrls, c.documentUrl) &&
        matches(filter.documentIds, c.documentId) &&
        matches(filter.documentOrigins, c.documentOrigin) &&
        matches(filter.tabIds, c.tabId) &&
        matches(filter.frameIds, c.frameId) &&
        matches(filter.contextIds, c.contextId) &&
        matches(filter.windowIds, c.windowId)
    )
  }

  /**
   * The offscreen document is created at engine start, inside the extension window, and kept for the session (§5.4),
   * so `createDocument` only waits for it to have finished loading (its module listeners are then
   * in place: background-core.js warns that a relay landing earlier finds nobody listening).
   */
  async offscreen({ action, url }) {
    if (action === 'has') return Boolean(this.readyContext('offscreen'))
    if (action === 'close') {
      this.report({ check: 'ext-host-offscreen-close-ignored', note: 'Kept alive for the session.' })
      return undefined
    }
    if (!this.descriptor.offscreen) throw Error('Offscreen documents are not available for this engine')
    const wanted = new URL(String(url ?? this.descriptor.offscreen).replace(/^\/+/, ''), this.origin + '/').href
    await this.until(
      () => [...this.contexts.values()].find((rec) => rec.kind === 'offscreen' && rec.ready && rec.url.split(/[?#]/)[0] === wanted.split(/[?#]/)[0]),
      OFFSCREEN_WAIT_MS,
      `The offscreen document ${wanted} did not load within ${OFFSCREEN_WAIT_MS / 1000}s`
    )
    return undefined
  }

  /**
   * `tabs.create`, `tabs.update({url})` and `openOptionsPage`. Extension pages open in the
   * `dictionary` panel, the way ui/overlay.js `openYomitan` shows Yomitan's: show the window, then
   * relay `{kind: 'navigate', url}` to it. Without native panels (the harness) the page is
   * offered to this document instead. Web links go to the system browser.
   */
  async open(rawUrl) {
    const url = new URL(String(rawUrl ?? ''), this.origin + '/').href
    const dictionaryTab = { id: tabIdFor('dictionary'), index: 0, windowId: 1, active: true, url, incognito: false }
    if (safeOrigin(url) === this.origin) {
      this.lastOpen = { url, at: Date.now() }
      try {
        await this.invoke('panel', { label: 'dictionary', action: 'show', rect: null })
        await this.invoke('ext_relay', { target: 'dictionary', payload: { kind: 'navigate', url } })
        this.report({ check: 'ext-host-open', url, where: 'dictionary' })
      } catch (error) {
        this.report({ check: 'ext-host-open', url, where: 'local', note: describe(error) })
        this.openLocally(url)
      }
      return dictionaryTab
    }
    if (/^https?:/.test(url)) {
      try {
        await this.invoke('plugin:shell|open', { path: url })
      } catch {
        this.win.open?.(url, '_blank', 'noopener')
      }
      return { id: -1, index: 0, windowId: 1, active: true, url, incognito: false }
    }
    throw Error(`Cannot open ${url}`)
  }

  /**
   * `onInstalled` once per engine (reason `install`, or `update` when the vendored version
   * changed), recorded in the file's host section so a later launch fires `onStartup` instead.
   * Hachidori's first install opens its startup page (background.js `beginFirstRunSetup`).
   */
  async install() {
    if (this.installAnswered) return { event: null }
    this.installAnswered = true
    const version = this.descriptor.manifest.version
    const previous = this.hostState.installed
    if (previous?.version === version) return { event: 'startup' }
    this.hostState.installed = { version, at: new Date().toISOString() }
    await this.persist().catch((error) => this.report({ check: 'ext-host-storage-save-failed', error: describe(error) }))
    return previous
      ? { event: 'installed', details: { reason: 'update', previousVersion: previous.version } }
      : { event: 'installed', details: { reason: 'install' } }
  }

  // ---------------------------------------------------------------- persistence (§5.4.1)

  /** What the storage file says the extension keeps in its origin's own storage. */
  persistenceClaims() {
    const spec = this.descriptor.persistence
    const claimed = spec ? spec.claimed(this.store.local) : []
    return { claimed, tag: this.hostState.store ?? null }
  }

  /**
   * The extension window's probe of those claims in the WebKit store this launch opened
   * (persistence.js). Something claimed that is positively absent means the file describes data
   * of another store (a bundle's, when this is the bare dev executable, or the other way round),
   * or data that was lost: the file is backed up (`storage_backup`), the descriptor's metadata
   * keys are removed so the extension starts from its clean "nothing installed" state, and
   * `ext-host-storage-desync` says why. Either way the file is then tagged with this store's
   * marker. A probe that could not tell changes nothing.
   */
  async reconcilePersistence({ store = null, fresh = false, checked = 0, missing = [], error = null } = {}) {
    const spec = this.descriptor.persistence
    const tag = this.hostState.store ?? null
    const outcome = { action: 'in-sync', tag, store, fresh, checked, missing: missing.length, error }
    // An unreadable file was never loaded: nothing here describes it, so nothing may be reset.
    if (this.storageUnreadable) return { ...outcome, action: 'kept' }
    if (spec && !error && missing.length > 0) {
      const keys = spec.metadataKeys.filter((key) => key in this.store.local)
      let backup = null
      try {
        backup = await this.invoke('storage_backup', { extension: this.engine })
      } catch (backupError) {
        // Without a backup nothing is removed: a stale list is recoverable, a lost one is not.
        this.report({ check: 'ext-host-storage-desync', engine: this.engine, action: 'kept', reason: 'backup-failed', error: describe(backupError), tag, store, fresh, missing: missing.slice(0, 20) })
        return { ...outcome, action: 'kept' }
      }
      await this.mutate('local', (local) => {
        for (const key of keys) delete local[key]
      }).catch(() => {})
      outcome.action = 'reset'
      this.report({
        check: 'ext-host-storage-desync',
        engine: this.engine,
        action: 'reset',
        // The marker says why: another store wrote this file, or this store lost the data.
        reason: tag && store && tag !== store ? 'other-store' : tag ? 'data-missing' : 'untagged-data-missing',
        tag,
        store,
        fresh,
        checked,
        missing: missing.slice(0, 20),
        removed: keys,
        backup
      })
    }
    if (store && tag !== store) {
      if (outcome.action === 'in-sync') this.report({ check: 'ext-host-storage-tagged', engine: this.engine, tag, store, fresh, checked })
      this.hostState.store = store
      await this.persist().catch((saveError) => this.report({ check: 'ext-host-storage-save-failed', error: describe(saveError) }))
    }
    return outcome
  }

  /** `__kimochiExtensionHost.clickAction()`: the toolbar button Kimochi does not have. */
  clickAction() {
    const tab = this.tab(1)
    for (const rec of this.contexts.values()) {
      if (rec.kind === 'background') rec.link.send(rec.id, { type: 'action-clicked', tab })
    }
  }
}

const safeOrigin = originOf
