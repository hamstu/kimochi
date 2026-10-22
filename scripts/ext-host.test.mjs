/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * The generic extension host (host/ext/, DICTIONARY_ENGINES.md §5), run for real.
 *
 * The bundle is built here from host/ext/entry.js with esbuild, in memory (nothing is written to
 * dist/), and evaluated in node:vm contexts standing in for the documents of a Kimochi session:
 * the overlay (the hub), its background and offscreen iframes, extension pages, the Log and the
 * dictionary panel. Iframes talk to their parent through fake MessagePorts, windows through a
 * fake Tauri `ext_relay` bus that stamps `{from, to, seq}` like main.rs `ext_relay`. The
 * "extension scripts" are small stand-ins that exercise the same `chrome.*` calls the real
 * Hachidori and 10ten code makes, at the same moments (background-core.js `relay`,
 * tab-manager.ts `enable?`/`enabled`, content.js `hd_reader_command`, …).
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { yomitanShimSource } from './yomitan-shims.mjs'

const root = new URL('../', import.meta.url)
// A path, not `URL.pathname`: on Windows the latter is `/C:/...`, which esbuild cannot resolve.
const built = await build({
  entryPoints: [fileURLToPath(new URL('host/ext/entry.js', root))],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'safari17',
  write: false,
  logLevel: 'silent'
})
const BUNDLE = built.outputFiles[0].text
const HACHIDORI_VERSION = JSON.parse(await readFile(new URL('extensions/hachidori.manifest.json', root), 'utf8')).version
const HACHIDORI_CONTENT = JSON.parse(await readFile(new URL('extensions/hachidori.manifest.json', root), 'utf8')).content_scripts[0].js
const TENTEN_LOCALE = await readFile(new URL('extensions/tenten.messages-en.json', root), 'utf8')

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
const ORIGINS = { hachidori: 'hachidori://localhost', tenten: 'tenten://localhost' }
const APP = 'tauri://localhost'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, message = 'condition', ms = 5000) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > ms) throw Error(`Timed out waiting for ${message}`)
    await sleep(5)
  }
}

/** Builds each window's DOM stand-in inside its own realm. */
const PRELUDE = `
(() => {
  const w = globalThis
  w.window = w
  w.self = w
  const et = new EventTarget()
  w.addEventListener = (...a) => et.addEventListener(...a)
  w.removeEventListener = (...a) => et.removeEventListener(...a)
  w.dispatchEvent = (e) => et.dispatchEvent(e)
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.localName = tag; this.dataset = {}; this.style = {}; this.attrs = {}; this.children = []; this.parentNode = null; this.__matches = [] }
    setAttribute(k, v) { this.attrs[k] = String(v) }
    getAttribute(k) { return this.attrs[k] ?? null }
    append(...nodes) { for (const n of nodes) { this.children.push(n); n.parentNode = this; __world.appended(w, n) } }
    prepend(...nodes) { this.append(...nodes) }
    remove() {}
    matches(selector) { return this.__matches.includes(selector) }
    closest(selector) { let e = this; while (e) { if (e.matches?.(selector)) return e; e = e.parentNode } return null }
    dispatchEvent(e) { return w.dispatchEvent(e) }
  }
  class Document {
    constructor() { this.head = new Element('head'); this.body = new Element('body'); this.documentElement = new Element('html'); this.readyState = 'complete'; this.scripts = [] }
    createElement(tag) { return new Element(tag) }
    addEventListener() {}
    removeEventListener() {}
    querySelector() { return null }
    querySelectorAll() { return [] }
    elementFromPoint(x, y) { return w.__hit(x, y) }
    elementsFromPoint(x, y) { const e = w.__hit(x, y); return e ? [e] : [] }
    caretRangeFromPoint(x, y) { const e = w.__hit(x, y); return e ? { startContainer: e, startOffset: 0 } : null }
    caretPositionFromPoint(x, y) { const e = w.__hit(x, y); return e ? { offsetNode: e, offset: 0 } : null }
  }
  w.Element = Element
  w.Document = Document
  w.document = new Document()
  w.__hits = []
  w.__hit = (x, y) => w.__hits.find((h) => x >= h.x0 && x < h.x1 && y >= h.y0 && y < h.y1)?.el ?? null
  w.innerWidth = 800
  w.innerHeight = 600
})()
`

class FakePort {
  constructor() {
    this.onmessage = null
    this.peer = null
    this.closed = false
  }

  postMessage(data) {
    if (this.closed) return
    const copy = structuredClone(data)
    setTimeout(() => {
      if (!this.peer.closed) this.peer.onmessage?.({ data: copy })
    }, 0)
  }

  start() {}
  close() {
    this.closed = true
  }
}
class FakeChannel {
  constructor() {
    this.port1 = new FakePort()
    this.port2 = new FakePort()
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

/** A Kimochi session: windows, their frames, the Tauri bus, the storage files. */
class World {
  constructor({ engine, files = {}, scripts = {}, pages = {}, storage = {}, panels = false } = {}) {
    this.engine = engine
    this.files = files
    this.scripts = scripts
    this.pages = pages
    this.storage = storage
    this.panels = panels
    this.saves = []
    this.reports = []
    this.invoked = []
    this.listeners = []
    this.seq = new Map()
    this.contexts = []
    this.sandboxes = new Map()
    this.extensionWindows = new Map()
    this.backups = []
    /**
     * Each extension origin's WebKit store as the extension window sees it: its localStorage and
     * IndexedDB (`{databases: {name: {store: Map(key → value)}}}`), surviving the window.
     */
    this.webkit = { hachidori: { localStorage: new Map(), databases: {} }, tenten: { localStorage: new Map(), databases: {} } }
    /** What `capture_frame_source` answers: `(scan) => {id, url, matched} | null`. */
    this.frameSource = () => null
  }

  tauriFor(label) {
    return {
      core: { invoke: async (command, args) => this.invoke(label, command, args) },
      event: {
        listen: async (name, callback) => {
          if (name === 'ext-relay' || name === `ext-relay:${label}`) this.listeners.push({ label, name, callback })
          return () => {}
        }
      }
    }
  }

  async invoke(label, command, args) {
    this.invoked.push({ label, command, args: structuredClone(args) })
    switch (command) {
      case 'storage_load':
        // `loadFailures`: that many reads fail (an I/O error native could not answer) first.
        if (this.loadFailures > 0) {
          this.loadFailures -= 1
          throw Error('native: could not read chrome-local file: Resource temporarily unavailable')
        }
        return structuredClone(this.storage[args.extension] ?? {})
      case 'storage_save':
        this.saves.push(structuredClone(args))
        this.storage[args.extension] = structuredClone(args.value)
        return null
      case 'report':
        this.reports.push(structuredClone(args.value))
        return null
      case 'ext_relay': {
        const seq = (this.seq.get(label) ?? 0) + 1
        this.seq.set(label, seq)
        const message = { from: label, to: args.target ?? null, seq, payload: structuredClone(args.payload) }
        setTimeout(() => {
          const name = args.target ? `ext-relay:${args.target}` : 'ext-relay'
          for (const listener of [...this.listeners]) {
            if (!listener.name || listener.name === name) listener.callback({ payload: structuredClone(message) })
          }
        }, 0)
        return null
      }
      case 'panel':
        if (!this.panels) throw Error('no native panels here')
        return null
      case 'storage_backup': {
        if (!this.storage[args.extension]) return null
        const name = `chrome-local-${args.extension}.json.bak-${this.backups.length + 1}`
        this.backups.push({ name, value: structuredClone(this.storage[args.extension]) })
        return name
      }
      case 'extension_window_ensure':
        return this.ensureExtensionWindow(args.engine, args.reload === true)
      case 'capture_frame_source':
        return structuredClone(this.frameSource(args.scan ?? null))
      case 'retain_frame':
        return true
      default:
        throw Error(`unknown command ${command}`)
    }
  }

  /**
   * main.rs `extension_window_ensure`: the engine's hidden extension window, a top-level window
   * labelled `ext-<id>` whose document is the background page on the extension origin (native
   * injects the label prelude and the host for all frames). Idempotent; `reload` replaces it.
   * `this.extensionWindowDelay` holds the window back, as a slow native turn would.
   */
  async ensureExtensionWindow(engine, reload = false) {
    const label = `ext-${engine}`
    if (this.refuseExtensionWindow) throw Error(this.refuseExtensionWindow)
    const existing = this.extensionWindows.get(label)
    if (existing && !reload) return { label, action: 'kept' }
    if (existing) this.closeExtensionWindow(engine)
    const open = () => {
      const win = this.window({ href: `${ORIGINS[engine]}/__kimochi/ext-background.html?engine=${engine}`, label, prelude: engine, tauri: true })
      this.attachStore(win, this.webkit[engine])
      this.extensionWindows.set(label, win)
      this.load(win)
    }
    if (this.extensionWindowDelay) setTimeout(open, this.extensionWindowDelay)
    else open()
    return { label, action: existing ? 'reloaded' : 'created' }
  }

  /** A minimal localStorage + IndexedDB over one origin's WebKit store (see `this.webkit`). */
  attachStore(win, store) {
    win.localStorage = {
      getItem: (k) => (store.localStorage.has(k) ? store.localStorage.get(k) : null),
      setItem: (k, v) => store.localStorage.set(k, String(v)),
      removeItem: (k) => store.localStorage.delete(k)
    }
    const later = (req, fn) => {
      setTimeout(() => {
        try {
          req.result = fn()
          req.onsuccess?.()
        } catch (error) {
          req.error = error
          req.onerror?.()
        }
      }, 0)
      return req
    }
    win.indexedDB = {
      databases: async () => Object.keys(store.databases).map((name) => ({ name, version: 1 })),
      open: (name) =>
        later({}, () => {
          const db = store.databases[name]
          if (!db) throw Error(`no database ${name}`)
          return {
            objectStoreNames: { contains: (s) => s in db },
            close() {},
            transaction: (s) => ({
              objectStore: () => ({
                count: (key) => later({}, () => (key === undefined ? db[s].size : db[s].has(key) ? 1 : 0))
              })
            })
          }
        })
    }
  }

  /** A closed (or reloading) window: its listeners stop hearing the relay; `pagehide` fires. */
  closeExtensionWindow(engine) {
    const label = `ext-${engine}`
    const win = this.extensionWindows.get(label)
    if (!win) return
    this.extensionWindows.delete(label)
    win.dispatchEvent(new Event('pagehide'))
    const inside = (context) => context === win || context.top === win
    this.listeners = this.listeners.filter((listener) => listener.label !== label)
    this.contexts = this.contexts.filter((context) => !inside(context))
  }

  /** One document. `parent` makes it a child frame of that window. */
  window({ href, label, mirror, prelude, origins = ORIGINS, tauri = false, noLocalStorage = false, parent = null }) {
    const url = new URL(href)
    const context = vm.createContext({
      URL, URLSearchParams, AbortController, Request, Response, Headers, ReadableStream, DOMException, TextEncoder, TextDecoder,
      Event, EventTarget, CustomEvent, KeyboardEvent: Event, MouseEvent: Event, PointerEvent: Event,
      console: { log() {}, warn() {}, error() {}, info() {} },
      // Unreferenced, so a host timer still pending when the tests end (a relay hello loop, a
      // delivery acknowledgement deadline) never keeps the test process alive. While the tests
      // run, `keepAlive` below holds the loop open instead: a test that awaits nothing but one of
      // these timers would otherwise drain the loop and be cancelled ("Promise resolution is
      // still pending but the event loop has already resolved"), as Node 22 does on CI.
      setTimeout: (...args) => setTimeout(...args).unref(),
      setInterval: (...args) => setInterval(...args).unref(),
      clearTimeout, clearInterval, queueMicrotask, structuredClone, btoa, atob, Blob,
      crypto: globalThis.crypto, MessageChannel: FakeChannel, __world: this
    })
    vm.runInContext(PRELUDE, context)
    const origin = `${url.protocol}//${url.host}`
    context.location = { href: url.href, origin, protocol: url.protocol, host: url.host, hostname: url.hostname, pathname: url.pathname, search: url.search, hash: url.hash }
    context.navigator = { language: 'en-US', languages: ['en-US'], platform: 'MacIntel' }
    context.frames = []
    context.top = parent ? parent.top : context
    context.parent = parent
      ? {
          postMessage: (data, targetOrigin, transfer = []) =>
            setTimeout(() => parent.__receive(data, origin, context, transfer), 0)
        }
      : context
    context.__receive = (data, from, source, ports) => {
      const event = new Event('message')
      Object.defineProperties(event, { data: { value: data }, origin: { value: from }, source: { value: source }, ports: { value: ports } })
      context.dispatchEvent(event)
    }
    if (noLocalStorage) {
      Object.defineProperty(context, 'localStorage', { get() { throw Error('SecurityError') } })
    } else {
      context.localStorage = mirror === undefined ? {} : { 'kimochi.dictionaryEngine': mirror }
    }
    if (label !== undefined) context.__kimochiPanelLabel = label
    if (prelude !== undefined) context.__kimochiDictionaryEngine = prelude
    if (origins) context.__kimochiExtensionOrigins = origins
    if (tauri) context.__TAURI__ = this.tauriFor(label)
    const files = this.files
    context.XMLHttpRequest = class {
      open(method, target) {
        this.url = new URL(target, url.href).href
      }

      send() {
        const file = files[this.url]
        this.status = file === undefined ? 404 : 200
        this.responseText = file ?? ''
      }
    }
    context.fetch = async (input) => {
      const target = new URL(String(input?.url ?? input), url.href).href
      if (this.remote && /^https?:/.test(target) && !target.startsWith(origin)) return this.remote(target)
      const file = files[target]
      return new Response(file ?? 'missing', { status: file === undefined ? 404 : 200 })
    }
    this.contexts.push(context)
    // Inside the realm `globalThis` is the context's global proxy, not the sandbox object node:vm
    // wants back; elements hand us the former.
    this.sandboxes.set(vm.runInContext('globalThis', context), context)
    return context
  }

  run(context, source, filename) {
    return vm.runInContext(source, context, filename ? { filename } : undefined)
  }

  load(context) {
    this.run(context, BUNDLE, `${context.location.origin}/__kimochi/ext-host.js`)
    return context
  }

  /** What the DOM does when the host appends an element: frames load, scripts run. */
  appended(inner, element) {
    const win = this.sandboxes.get(inner) ?? inner
    if (element.localName === 'iframe') {
      setTimeout(() => this.frame(win, element.src, element), 0)
    } else if (element.localName === 'script' && element.src) {
      setTimeout(() => {
        const source = this.scripts[element.src]
        if (source === undefined) return element.onerror?.()
        try {
          this.run(win, source, element.src)
        } catch (error) {
          if (process.env.EXT_DEBUG) console.error('script failed', element.src, error)
          return element.onerror?.(error)
        }
        element.onload?.()
      }, 0)
    }
  }

  /** A child frame of `parent` showing `src`, with the host injected first, as native does. */
  frame(parent, src, element = {}) {
    const url = new URL(src)
    const engine = Object.entries(ORIGINS).find(([, o]) => src.startsWith(o))?.[0]
    const child = this.window({ href: src, prelude: engine, parent })
    element.contentWindow = child
    parent.frames.push(child)
    this.load(child)
    const page = this.pages[url.pathname]
    if (page) this.run(child, page, src)
    child.dispatchEvent(new Event('load'))
    return child
  }
}

const result = (context, source) => vm.runInContext(source, context)

/** Fake Hachidori: the calls its background, offscreen document and settings page make. */
const HACHIDORI = {
  background: `
    globalThis.lifecycle = []
    // background.js reads its dictionary list at load.
    chrome.storage.local.get('dictionaryState').then((s) => { globalThis.dictionariesAtLoad = (s?.dictionaryState?.dictionaries ?? []).length })
    chrome.runtime.onInstalled.addListener((details) => lifecycle.push(details))
    chrome.runtime.onStartup.addListener(() => lifecycle.push('startup'))
    chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
      if (m?.case === 'race') { setTimeout(() => sendResponse('slow-background'), 500); return true }
      if (m?.case === 'async-true') { setTimeout(() => sendResponse({ ok: 'later' }), 10); return true }
      if (m?.case === 'promise') return Promise.resolve('from-promise')
      if (m?.case === 'sender') { sendResponse(sender); return false }
      return false
    })
    chrome.runtime.onConnect.addListener((port) => {
      port.onMessage.addListener((msg) => port.postMessage({ echo: msg, name: port.name, sender: port.sender }))
    })
  `,
  // content.js `onReaderCommand`: the in-page command channel the host drives.
  content: `
    globalThis.readerCommands = []
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.target === 'hachidori-reader' && message.type === 'hd_reader_command') readerCommands.push(message.action)
      return false
    })
  `,
  offscreen: `
    // offscreen.js readEngineConfig: asks the background at module load, before its script ran.
    chrome.runtime.sendMessage({ case: 'promise' }).then((r) => { globalThis.early = r }, (e) => { globalThis.early = 'error: ' + e.message })
    globalThis.offscreenSeen = []
    chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
      offscreenSeen.push(m)
      if (m?.type === 'hd_status') { sendResponse(globalThis.engineStatus ?? { ok: true, ready: true, dictionaryCount: 1 }); return false }
      if (m?.case === 'race') sendResponse('fast-offscreen')
      if (m?.case === 'bgsender') sendResponse(sender)
      return false
    })
  `
}

async function hachidoriSession(options = {}) {
  const origin = ORIGINS.hachidori
  const world = new World({
    engine: 'hachidori',
    panels: options.panels ?? false,
    storage: options.storage ?? {},
    scripts: {
      ...Object.fromEntries(HACHIDORI_CONTENT.map((file) => [`${origin}/${file}`, ''])),
      [`${origin}/content.js`]: HACHIDORI.content,
      [`${origin}/background.js`]: HACHIDORI.background
    },
    pages: { '/offscreen.html': HACHIDORI.offscreen }
  })
  options.prepare?.(world)
  const overlay = world.load(world.window({ href: `${APP}/ui/overlay.html`, label: 'overlay', mirror: 'hachidori', tauri: true }))
  const started = await result(overlay, '__kimochiExtensionHost.start({ scope: null, host: true })')
  if (process.env.EXT_DEBUG) console.error(JSON.stringify(started), JSON.stringify(world.reports, null, 1))
  if (started.ready) await waitFor(() => world.reports.some((r) => r.check === 'dictionary-readiness' && r.phase === 'ready'), 'Hachidori data readiness')
  const background = world.contexts.find((c) => c.location.pathname === '/__kimochi/ext-background.html')
  const offscreen = world.contexts.find((c) => c.location.pathname === '/offscreen.html')
  return { world, overlay, started, background, offscreen, origin }
}

test('Hachidori content coalesces obsolete interactive lookups before relaying to its worker', async () => {
  const { overlay, offscreen } = await hachidoriSession()
  result(offscreen, `
    globalThis.lookupJobs = []
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type !== 'hd_lookup') return false
      return new Promise((resolve) => lookupJobs.push({ message, resolve }))
    })
  `)
  const complete = result(overlay, `Promise.allSettled(Array.from({length: 20}, (_, i) =>
    chrome.runtime.sendMessage({target:'hoshidicts-offscreen', type:'hd_lookup', requestId:'lookup-'+i, text:'word-'+i})))`)
  await waitFor(() => result(offscreen, 'lookupJobs.length') === 1, 'first hover lookup')
  result(offscreen, 'lookupJobs[0].resolve({requestId:lookupJobs[0].message.requestId, ok:true})')
  await waitFor(() => result(offscreen, 'lookupJobs.length') === 2, 'newest hover lookup')
  assert.equal(result(offscreen, 'lookupJobs[1].message.text'), 'word-19')
  result(offscreen, 'lookupJobs[1].resolve({requestId:lookupJobs[1].message.requestId, ok:true})')
  const replies = await complete
  assert.equal(replies[0].value.requestId, 'lookup-0')
  assert.equal(replies[19].value.requestId, 'lookup-19')
  assert.equal(replies.filter((reply) => reply.status === 'rejected').length, 18)
  assert.match(replies[1].reason.message, /superseded/)
  // Programmatic requests do not use content.js's interactive request IDs.
  const ordinary = result(overlay, `Promise.all(Array.from({length: 3}, (_, i) =>
    chrome.runtime.sendMessage({target:'hoshidicts-offscreen', type:'hd_lookup', requestId:'api-'+i})))`)
  await waitFor(() => result(offscreen, 'lookupJobs.length') === 5, 'independent API lookups')
  result(offscreen, 'lookupJobs.slice(2).forEach(job=>job.resolve({ok:true}))')
  assert.equal((await ordinary).length, 3)
})

/** Fake 10ten: tab-manager.ts's `enable?` / `enabled` handshake and a content listener. */
const TENTEN = {
  background: `
    globalThis.lifecycle = []
    browser.runtime.onInstalled.addListener((details) => lifecycle.push(details))
    browser.runtime.onMessage.addListener((req, sender) => {
      if (req?.type === 'enable?') {
        if (!sender.tab || typeof sender.tab.id !== 'number') return undefined
        void browser.tabs.sendMessage(sender.tab.id, { type: 'enable', frame: '*' }, { frameId: sender.frameId }).catch(() => {})
        return undefined
      }
      if (req?.type === 'enabled') return Promise.resolve({ frameId: sender.frameId })
      if (req?.type === 'sender') return Promise.resolve(sender)
      return undefined
    })
    browser.runtime.onConnect.addListener((port) => {
      if (port.name === 'options' && port.sender.tab?.id === 1) {
        globalThis.dataPort = port
        port.postMessage({ type: 'dbstateupdated', state: {
          words: { state: 'ok' }, kanji: { state: 'ok' }, radicals: { state: 'ok' }, names: { state: 'ok' }, updateState: { type: 'idle' }
        } })
      }
      port.onMessage.addListener((msg) => port.postMessage({ echo: msg, tab: port.sender.tab?.id }))
    })
  `,
  content: `
    globalThis.contentSeen = []
    browser.runtime.onMessage.addListener(async (req) => {
      contentSeen.push(req)
      if (req.type === 'enable') {
        const reply = await browser.runtime.sendMessage({ type: 'enabled', src: location.href })
        globalThis.enabledFrameId = reply.frameId
      }
      return 'ok'
    })
    browser.runtime.sendMessage({ type: 'enable?' }).catch(() => {})
  `
}

async function tentenSession(options = {}) {
  const origin = ORIGINS.tenten
  const world = new World({
    engine: 'tenten',
    panels: options.panels ?? false,
    storage: options.storage ?? {},
    files: { [`${origin}/_locales/en/messages.json`]: TENTEN_LOCALE },
    scripts: {
      [`${origin}/10ten-ja-background.js`]: TENTEN.background,
      [`${origin}/10ten-ja-content.js`]: TENTEN.content
    }
  })
  options.prepare?.(world)
  const overlay = world.load(world.window({ href: `${APP}/ui/overlay.html`, label: 'overlay', mirror: 'tenten', tauri: true }))
  const started = await result(overlay, '__kimochiExtensionHost.start({ scope: null, host: true })')
  const background = world.contexts.find((c) => c.location.pathname === '/__kimochi/ext-background.html')
  if (started.ready) await waitFor(() => world.reports.some((r) => r.check === 'dictionary-readiness' && r.phase === 'ready'), '10ten data readiness')
  return { world, overlay, started, background, origin }
}

// ---------------------------------------------------------------- engine resolution

const keepAlive = setInterval(() => {}, 1000)
after(() => clearInterval(keepAlive))

test('the host stands down for Yomitan, builtin and custom-api, and installs for the two extensions', () => {
  for (const mirror of ['yomitan', 'builtin', 'custom-api']) {
    const world = new World()
    const win = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror }))
    assert.equal(result(win, 'typeof __kimochiExtensionHost'), 'undefined', mirror)
    assert.equal(result(win, 'typeof chrome'), 'undefined', mirror)
  }
  const world = new World()
  const fromPrelude = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', prelude: 'tenten' }))
  assert.equal(result(fromPrelude, '__kimochiExtensionHost.engine'), 'tenten')
  const noStorage = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', prelude: 'hachidori', noLocalStorage: true }))
  assert.equal(result(noStorage, '__kimochiExtensionHost.engine'), 'hachidori')
  const mirrorWins = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror: 'hachidori', prelude: 'tenten' }))
  assert.equal(result(mirrorWins, '__kimochiExtensionHost.engine'), 'hachidori')
  const prelude = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', prelude: 'custom-api' }))
  assert.equal(result(prelude, 'typeof __kimochiExtensionHost'), 'undefined', 'custom-api from the prelude needs no host')
})

test('Hachidori and 10ten preserve the Windows WebView2 IPC bridge when installing chrome', () => {
  for (const engine of ['hachidori', 'tenten']) {
    const world = new World()
    const win = world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror: engine })
    win.__KIMOCHI_PLATFORM__ = { os: 'windows', arch: 'aarch64' }
    const messages = []
    const webview = { postMessage: (message) => messages.push(message) }
    win.chrome = { webview }
    world.load(win)
    assert.equal(win.chrome.webview, webview, engine)
    result(win, 'chrome.webview.postMessage("native IPC")')
    assert.deepEqual(messages, ['native IPC'])
    assert.equal(typeof win.chrome.runtime.sendMessage, 'function', 'extension API still installed')
  }
})
test('an extension frame takes its engine from its own origin, which the prelude names', () => {
  const world = new World({ files: { 'tenten://localhost/_locales/en/messages.json': TENTEN_LOCALE } })
  const dictionary = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'dictionary', mirror: 'tenten' }))
  // Native's prelude for a frame whose origin is an extension origin names that extension, since
  // the frame cannot read the app origin's localStorage mirror.
  const options = world.window({ href: 'tenten://localhost/options.html', prelude: 'tenten', parent: dictionary })
  world.load(options)
  assert.equal(result(options, '__kimochiExtensionHost.engine'), 'tenten')
  assert.equal(result(options, '__kimochiExtensionHost.kind'), 'page')
  assert.equal(result(options, 'chrome.runtime.getURL("")'), 'tenten://localhost/')
  // A loopback per-port origin (the harness) with no prelude is recognised by its manifest.
  const harnessWorld = new World({
    files: { 'http://127.0.0.1:1441/manifest.json': JSON.stringify({ name: '10ten Japanese Reader (Rikaichamp)', version: '1.28.0' }) }
  })
  const harness = harnessWorld.load(harnessWorld.window({ href: 'http://127.0.0.1:1430/ui/dictionary-harness.html', mirror: 'tenten', origins: { tenten: 'http://127.0.0.1:1441' } }))
  const frame = harnessWorld.window({ href: 'http://127.0.0.1:1441/options.html', origins: null, parent: harness })
  harnessWorld.load(frame)
  assert.equal(result(frame, '__kimochiExtensionHost.engine'), 'tenten')
})

test('the Yomitan shims install only for yomitan and builtin', async () => {
  const panelShim = await yomitanShimSource('panel-shim.js', { network: 'Promise.resolve()' })
  const cases = [['tenten', false], ['hachidori', false], ['builtin', true], [undefined, true]]
  for (const [mirror, installs] of cases) {
    const world = new World()
    const win = world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror })
    win.fetch = async () => ({ json: async () => ({}) })
    world.run(win, panelShim)
    assert.equal(result(win, 'Boolean(window.__yomitanPanelShim)'), installs, `panel-shim with ${mirror}`)
    world.load(win)
    // Exactly one host per document.
    assert.equal(result(win, 'typeof __kimochiExtensionHost') === 'object', !installs, `ext host with ${mirror}`)
  }
})

test("no host installs for 'none' (nothing downloaded, or the Yomitan API, which needs none)", async () => {
  const panelShim = await yomitanShimSource('panel-shim.js', { network: 'Promise.resolve()' })
  // From the mirror, and from native's prelude when there is no mirror yet. The Yomitan API is
  // mirrored as 'none'; its stored spelling, wherever it turns up, installs nothing either.
  const cases = [
    { mirror: 'none' },
    { prelude: 'none' },
    { mirror: 'none', prelude: 'yomitan' },
    { mirror: 'custom-api' },
    { prelude: 'custom-api' }
  ]
  for (const options of cases) {
    const world = new World()
    const win = world.window({ href: `${APP}/app/panel.html`, label: 'log', ...options })
    win.fetch = async () => ({ json: async () => ({}) })
    world.run(win, panelShim)
    world.load(win)
    const name = JSON.stringify(options)
    assert.equal(result(win, 'Boolean(window.__yomitanPanelShim)'), false, `panel-shim with ${name}`)
    assert.equal(result(win, 'typeof __kimochiExtensionHost'), 'undefined', `ext host with ${name}`)
  }
})

// ---------------------------------------------------------------- getURL

test("getURL('') carries the extension origin, and a protocol unlike the page's", () => {
  const world = new World()
  const mac = world.load(world.window({ href: `${APP}/ui/overlay.html`, label: 'overlay', mirror: 'hachidori' }))
  assert.equal(result(mac, 'chrome.runtime.getURL("")'), 'hachidori://localhost/')
  assert.equal(result(mac, 'chrome.runtime.getURL("/render/reader.css")'), 'hachidori://localhost/render/reader.css')
  // Windows and the harness serve both origins over http; Hachidori's content.js would then
  // refuse to start its reader, so the empty path alone answers with another protocol.
  for (const [page, origin] of [['http://tauri.localhost/ui/overlay.html', 'http://hachidori.localhost'], ['http://127.0.0.1:1430/ui/dictionary-harness.html', 'http://127.0.0.1:1440']]) {
    const win = world.load(world.window({ href: page, label: 'overlay', mirror: 'hachidori', origins: { hachidori: origin } }))
    const empty = result(win, 'chrome.runtime.getURL("")')
    assert.notEqual(new URL(empty).protocol, 'http:', page)
    assert.equal(result(win, 'chrome.runtime.getURL("content.css")'), `${origin}/content.css`)
  }
})

// ---------------------------------------------------------------- the hub and its contexts

test('the overlay hub starts the background and offscreen documents and reports ready', async () => {
  const { world, started, background, offscreen, overlay } = await hachidoriSession()
  assert.deepEqual({ ...started }, { ready: true })
  assert.ok(background && offscreen, 'both iframes were created')
  assert.equal(background.location.search, '?engine=hachidori')
  assert.deepEqual(result(background, 'JSON.stringify(lifecycle)'), JSON.stringify([{ reason: 'install' }]))
  // A message sent while the background script was still loading waited for it, as Chrome's
  // worker wake-up does, instead of failing with "Receiving end does not exist".
  await waitFor(() => result(offscreen, 'globalThis.early'), 'early message')
  assert.equal(result(offscreen, 'early'), 'from-promise')
  const ready = world.reports.find((r) => r.check === 'ext-host-ready')
  assert.equal(ready.ready, true)
  assert.equal(ready.background, 'ready')
  assert.equal(ready.offscreen, 'ready')
  assert.equal(ready.engine, 'hachidori')
  const setup = world.reports.filter((r) => r.check === 'dictionary-readiness')
  assert.equal(setup[0].settingsReady, false, 'settings stay hidden during initialization')
  assert.equal(setup.at(-1).settingsReady, true, 'settings open once the host initialized')
  // A second start is the same promise; the host is idempotent.
  assert.equal(result(overlay, '__kimochiExtensionHost.start({host: true}) === __kimochiExtensionHost.start({host: true})'), true)
  // The install record lives in the host's own section, invisible to the extension.
  assert.equal(world.storage.hachidori.host.installed.version, HACHIDORI_VERSION)
  const local = await result(background, 'chrome.storage.local.get(null)')
  assert.equal(Object.keys(local).length, 0)
  // offscreen.createDocument resolves for the document that is already up, and getContexts sees it.
  await result(background, 'chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["DOM_SCRAPING"], justification: "x" })')
  const contexts = await result(background, 'chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")] })')
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].documentUrl, 'hachidori://localhost/offscreen.html')
})

// ---------------------------------------------------------------- the extension window

test('the background is the top document of the hidden ext-<id> window and relays to the overlay hub', async () => {
  const { world, overlay, started, background, offscreen } = await hachidoriSession()
  assert.deepEqual({ ...started }, { ready: true })
  // The hub asked native for the window instead of framing the documents itself.
  const ensure = world.invoked.filter((i) => i.command === 'extension_window_ensure')
  assert.deepEqual(ensure.map((i) => [i.label, i.args.engine, i.args.reload]), [['overlay', 'hachidori', false]])
  assert.equal(overlay.frames.length, 0, 'the overlay frames nothing')
  assert.equal(background.top, background, 'the background page is a top-level document')
  assert.equal(result(background, '__kimochiExtensionHost.window'), 'ext-hachidori')
  assert.equal(result(background, '__kimochiExtensionHost.kind'), 'background')
  // The offscreen document is the extension window's child, same-origin with its top document.
  assert.equal(offscreen.top, background)
  assert.equal(offscreen.location.href, 'hachidori://localhost/offscreen.html')
  assert.ok(world.reports.some((r) => r.check === 'ext-host-offscreen-created' && r.window === 'ext-hachidori'))
  assert.ok(world.reports.some((r) => r.check === 'ext-host-frame-linked' && r.kind === 'offscreen' && r.window === 'ext-hachidori'))
  // Both contexts reached the hub over ext_relay from the window's own label.
  const fromWindow = world.invoked.filter((i) => i.label === 'ext-hachidori' && i.command === 'ext_relay')
  assert.ok(fromWindow.some((i) => i.args.target === 'overlay' && i.args.payload.op === 'register' && i.args.payload.args.kind === 'background'))
  assert.ok(fromWindow.some((i) => i.args.target === 'overlay' && i.args.payload.op === 'register' && i.args.payload.args.kind === 'offscreen'))
  assert.ok(fromWindow.every((i) => i.args.payload.kind === 'ext' && i.args.payload.engine === 'hachidori'))
  // The window's diagnostics go to native directly, under its own label.
  assert.ok(world.reports.some((r) => r.window === 'ext-hachidori' && r.check === 'ext-host-background-started'))
  // The only native commands the extension window used are the two its invoke guard allows.
  const used = new Set(world.invoked.filter((i) => i.label === 'ext-hachidori').map((i) => i.command))
  assert.deepEqual([...used].sort(), ['ext_relay', 'report'])
  // Hub state: both ready, as before.
  assert.deepEqual(
    (({ background: b, offscreen: o, ready }) => ({ b, o, ready }))(result(overlay, '__kimochiExtensionHost.status()')),
    { b: 'ready', o: 'ready', ready: true }
  )
})

test('ports and messages cross between the Log, a dictionary-panel page and the extension window', async () => {
  const { world, background, offscreen } = await hachidoriSession()
  const log = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror: 'hachidori', tauri: true }))
  await result(log, '__kimochiExtensionHost.start({ scope: "[data-yomitan-scan]" })')
  // Log content → background (in ext-hachidori) port, through the hub in the overlay.
  result(log, 'globalThis.got = []; globalThis.port = chrome.runtime.connect({ name: "reader" }); port.onMessage.addListener((m) => got.push(m)); port.postMessage({ n: 1 })')
  await waitFor(() => result(log, 'got.length'), 'Log ↔ background port echo')
  assert.equal(result(log, 'got[0].echo.n'), 1)
  assert.equal(result(log, 'got[0].sender.tab.id'), result(log, '__kimochiExtensionHost.tabId'))
  // The dictionary panel's options iframe hops to its top document, which relays (unchanged path).
  const dictionary = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'dictionary', mirror: 'hachidori', tauri: true }))
  const page = world.frame(dictionary, 'hachidori://localhost/settings.html?tab=dictionaries')
  await waitFor(() => world.reports.some((r) => r.check === 'ext-host-frame-linked' && r.window === 'dictionary'), 'dictionary page linked')
  const sender = await result(page, 'chrome.runtime.sendMessage({ case: "sender" })')
  assert.equal(sender.url, 'hachidori://localhost/settings.html?tab=dictionaries')
  assert.equal(sender.tab, undefined)
  assert.equal(await result(page, 'chrome.runtime.sendMessage({ case: "race" })'), 'fast-offscreen')
  result(page, 'globalThis.got = []; globalThis.port = chrome.runtime.connect({ name: "hachidori-backup-settings" }); port.onMessage.addListener((m) => got.push(m)); port.postMessage({ token: "p" })')
  await waitFor(() => result(page, 'got.length'), 'dictionary page ↔ background port echo')
  assert.equal(result(page, 'got[0].sender.url'), 'hachidori://localhost/settings.html?tab=dictionaries')
  // background → offscreen still sees the worker script as its sender.
  const fromBackground = await result(background, 'chrome.runtime.sendMessage({ case: "bgsender" })')
  assert.equal(fromBackground.url, 'hachidori://localhost/background.js')
  assert.ok(offscreen)
})

test('settings messages and ports wait when the engine window has not registered yet', async () => {
  const origin = ORIGINS.hachidori
  const world = new World({
    engine: 'hachidori',
    scripts: { [`${origin}/background.js`]: HACHIDORI.background },
    pages: { '/offscreen.html': HACHIDORI.offscreen }
  })
  world.extensionWindowDelay = 300
  const overlay = world.load(world.window({ href: `${APP}/ui/overlay.html`, label: 'overlay', mirror: 'hachidori', tauri: true }))
  const starting = result(overlay, '__kimochiExtensionHost.start({ scope: null, host: true })')
  const dictionary = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'dictionary', mirror: 'hachidori', tauri: true }))
  const page = world.frame(dictionary, `${origin}/settings.html`)
  result(page, `
    globalThis.answer = chrome.runtime.sendMessage({ case: 'race' }).catch((e) => 'error: ' + e.message)
    globalThis.got = []
    const port = chrome.runtime.connect({ name: 'early-settings' })
    port.onMessage.addListener((m) => got.push(m))
    port.postMessage({ early: true })
  `)
  // Whoever answers, the early message was held until the engine window registered, then
  // delivered. The offscreen document usually answers first; on a slow machine it may not exist
  // yet when the queue drains, and the background's later answer is the one that comes back.
  assert.ok(['fast-offscreen', 'slow-background'].includes(await result(page, 'answer')))
  await starting
  await waitFor(() => result(page, 'got.length'), 'early settings port echo')
  assert.equal(result(page, 'got[0].echo.early'), true)
})

test('the hub waits for an extension window that comes up late', async () => {
  const origin = ORIGINS.tenten
  const world = new World({
    engine: 'tenten',
    files: { [`${origin}/_locales/en/messages.json`]: TENTEN_LOCALE },
    scripts: { [`${origin}/10ten-ja-background.js`]: TENTEN.background, [`${origin}/10ten-ja-content.js`]: TENTEN.content }
  })
  world.extensionWindowDelay = 300
  const overlay = world.load(world.window({ href: `${APP}/ui/overlay.html`, label: 'overlay', mirror: 'tenten', tauri: true }))
  const started = await result(overlay, '__kimochiExtensionHost.start({ scope: null, host: true })')
  assert.deepEqual({ ...started }, { ready: true })
  const ready = world.reports.find((r) => r.check === 'ext-host-ready')
  assert.equal(ready.background, 'ready')
  assert.equal(ready.offscreen, 'not-used')
  assert.ok(world.reports.some((r) => r.check === 'ext-host-window' && r.action === 'created'))
})

test('a window native will not open fails the start plainly; the retry asks for a fresh window', async () => {
  const origin = ORIGINS.tenten
  const world = new World({
    engine: 'tenten',
    files: { [`${origin}/_locales/en/messages.json`]: TENTEN_LOCALE },
    scripts: { [`${origin}/10ten-ja-background.js`]: TENTEN.background, [`${origin}/10ten-ja-content.js`]: TENTEN.content }
  })
  world.refuseExtensionWindow = 'invalid: hachidori is not the active dictionary engine'
  const overlay = world.load(world.window({ href: `${APP}/ui/overlay.html`, label: 'overlay', mirror: 'tenten', tauri: true }))
  const failed = await result(overlay, '__kimochiExtensionHost.start({ scope: null, host: true })')
  assert.equal(failed.ready, false)
  assert.match(failed.error, /background window could not be opened: invalid: hachidori is not the active/)
  world.refuseExtensionWindow = null
  const started = await result(overlay, '__kimochiExtensionHost.start({ scope: null, host: true })')
  assert.deepEqual({ ...started }, { ready: true })
  const ensure = world.invoked.filter((i) => i.command === 'extension_window_ensure').map((i) => i.args.reload)
  assert.deepEqual(ensure, [false, true])
})

test('an extension window that reloads re-registers; the hub drops the old contexts first', async () => {
  const { world, overlay } = await tentenSession()
  world.closeExtensionWindow('tenten')
  await world.ensureExtensionWindow('tenten')
  const fresh = world.extensionWindows.get('ext-tenten')
  await waitFor(() => world.reports.filter((r) => r.check === 'ext-host-context-gone' && r.kind === 'background').length === 1, 'old background dropped')
  await waitFor(() => {
    const status = result(overlay, '__kimochiExtensionHost.status()')
    return status.background === 'ready'
  }, 'new background ready')
  // One background in the table, and it answers.
  result(overlay, 'globalThis.enabledReply = null')
  const reply = await result(overlay, 'browser.runtime.sendMessage({ type: "enabled" })')
  assert.equal(reply.frameId, 0)
  assert.equal(result(fresh, '__kimochiExtensionHost.window'), 'ext-tenten')
})

test('an overlay that restarts gets the extension window back without reloading it', async () => {
  const { world, overlay, background } = await hachidoriSession()
  const scriptRuns = result(background, 'lifecycle.length')
  // The overlay reloads (dev live reload): its listeners go, a new document with a new hub comes up.
  world.listeners = world.listeners.filter((listener) => listener.label !== 'overlay')
  overlay.dispatchEvent(new Event('pagehide'))
  const second = world.load(world.window({ href: `${APP}/ui/overlay.html`, label: 'overlay', mirror: 'hachidori', tauri: true }))
  const started = await result(second, '__kimochiExtensionHost.start({ scope: null, host: true })')
  assert.deepEqual({ ...started }, { ready: true })
  // The background and offscreen re-registered as ready; nothing ran twice in the window.
  const status = result(second, '__kimochiExtensionHost.status()')
  assert.equal(status.background, 'ready')
  assert.equal(status.offscreen, 'ready')
  assert.equal(result(background, 'lifecycle.length'), scriptRuns)
  assert.ok(world.reports.some((r) => r.check === 'ext-host-relay-rebound' && r.window === 'ext-hachidori'))
  assert.equal(await result(second, 'chrome.runtime.sendMessage({ case: "promise" })'), 'from-promise')
})

test("the extension window fetches through plugin-http itself, and serves its offscreen frame's requests", async () => {
  const { world, offscreen, background } = await hachidoriSession()
  const seen = []
  world.remote = async (url) => {
    seen.push(url)
    const response = new Response(new Uint8Array([9, 8, 7]), { status: 200 })
    Object.defineProperty(response, 'url', { value: `${url}?final` })
    return response
  }
  const fromOffscreen = await result(offscreen, `fetch('https://github.com/a.zip').then(async (r) => [r.url, [...new Uint8Array(await r.arrayBuffer())]])`)
  assert.deepEqual(JSON.parse(JSON.stringify(fromOffscreen)), ['https://github.com/a.zip?final', [9, 8, 7]])
  const fromBackground = await result(background, `fetch('https://api.jiten.moe/x').then((r) => r.url)`)
  assert.equal(fromBackground, 'https://api.jiten.moe/x?final')
  assert.deepEqual(seen, ['https://github.com/a.zip', 'https://api.jiten.moe/x'])
  // Nothing crossed to the overlay for it.
  assert.ok(!world.invoked.some((i) => i.command === 'ext_relay' && JSON.stringify(i.args.payload).includes('github.com/a.zip')))
})

test("the harness's loopback extension window, and its offscreen child, are recognised without a prelude", async () => {
  const origin = 'http://127.0.0.1:1440'
  const manifest = JSON.parse(await readFile(new URL('extensions/hachidori.manifest.json', root), 'utf8'))
  const world = new World({
    engine: 'hachidori',
    files: { [`${origin}/manifest.json`]: JSON.stringify({ name: manifest.name, version: manifest.version }) },
    scripts: { [`${origin}/background.js`]: HACHIDORI.background },
    pages: { '/offscreen.html': HACHIDORI.offscreen }
  })
  // A bare stand-in for the overlay's hub on the relay: enough for the window to register and
  // finish its storage check (§5.4.1), after which it creates the offscreen frame.
  let nextCtx = 0
  world.listeners.push({
    label: 'overlay',
    callback: ({ payload: { from, to, payload } }) => {
      if (to !== 'overlay' || payload?.kind !== 'ext' || payload.type !== 'call') return
      const values = { hello: { hub: 'H-STAND-IN', ready: false }, register: { ctx: ++nextCtx }, persistenceClaims: { claimed: [], tag: null } }
      void world.invoke('overlay', 'ext_relay', { target: from, payload: { kind: 'ext', engine: 'hachidori', type: 'reply', id: payload.id, ok: true, value: values[payload.op] } })
    }
  })
  // What ui/dictionary-harness-native.js publishes on that page, standing in for native's preludes.
  const ext = world.window({
    href: `${origin}/__kimochi/ext-background.html?engine=hachidori&window=ext-hachidori`,
    label: 'ext-hachidori',
    origins: { hachidori: origin, tenten: 'http://127.0.0.1:1441' },
    tauri: true
  })
  world.load(ext)
  assert.equal(result(ext, '__kimochiExtensionHost.window'), 'ext-hachidori')
  const offscreen = await waitFor(() => world.contexts.find((c) => c.location.pathname === '/offscreen.html'), 'offscreen frame')
  assert.equal(offscreen.top, ext)
  assert.equal(result(offscreen, '__kimochiExtensionHost.engine'), 'hachidori')
  assert.equal(result(offscreen, '__kimochiExtensionHost.kind'), 'offscreen')
  assert.equal(result(offscreen, '__kimochiExtensionHost.window'), null)
})

// ---------------------------------------------------------------- storage file ↔ WebKit store (§5.4.1)

const GEN_A = '/dicts/.hdw-generation-aaaa/Jitendex.org [2026-10-03]'
const GEN_B = '/dicts/.hdw-generation-bbbb/JMnedict [2026-10-11]'
const claimedFile = (extra = {}) => ({
  hachidori: {
    local: { options: { theme: 'dark' }, dictionaryState: { dictionaries: [{ title: 'Jitendex', path: GEN_A }, { title: 'JMnedict', path: GEN_B }], groups: [] } },
    sync: {},
    host: { installed: { version: HACHIDORI_VERSION }, ...extra }
  }
})
const idbfs = (...paths) => ({ '/dicts': { FILE_DATA: new Map(paths.map((p) => [p, { mode: 16877 }])) } })

test('dictionaries the storage file lists but this WebKit store lacks are reset, after a backup, before the extension reads them', async () => {
  // The user's case: installed by a bundle (another store), launched as the bare dev executable.
  const { world, background, started } = await hachidoriSession({
    storage: claimedFile(),
    prepare: (w) => {
      w.webkit.hachidori.databases = idbfs(GEN_A) // one of the two is here, one is not
    }
  })
  assert.deepEqual({ ...started }, { ready: true })
  const desync = world.reports.find((r) => r.check === 'ext-host-storage-desync')
  assert.equal(desync.action, 'reset')
  assert.equal(desync.reason, 'untagged-data-missing')
  assert.deepEqual([...desync.missing], [GEN_B])
  assert.deepEqual([...desync.removed], ['dictionaryState'])
  assert.equal(desync.backup, 'chrome-local-hachidori.json.bak-1')
  // The backup holds the file as it was; the file keeps everything else, and is now tagged.
  assert.equal(world.backups[0].value.local.dictionaryState.dictionaries.length, 2)
  assert.equal(world.storage.hachidori.local.dictionaryState, undefined)
  assert.deepEqual(world.storage.hachidori.local.options, { theme: 'dark' })
  const marker = world.webkit.hachidori.localStorage.get('kimochi.extensionStore')
  assert.match(marker, /^S[0-9A-F]+$/)
  assert.equal(world.storage.hachidori.host.store, marker)
  assert.equal(world.storage.hachidori.host.installed.version, HACHIDORI_VERSION)
  // background.js saw the clean state at load, not the stale list.
  await waitFor(() => result(background, 'globalThis.dictionariesAtLoad !== undefined'), 'background read')
  assert.equal(result(background, 'dictionariesAtLoad'), 0)
  // Only the overlay backed up; the extension window used ext_relay and report only.
  assert.deepEqual([...new Set(world.invoked.filter((i) => i.label === 'ext-hachidori').map((i) => i.command))].sort(), ['ext_relay', 'report'])
})

test('a store that holds every listed dictionary is left alone and tagged; the next launch is silent', async () => {
  const first = await hachidoriSession({ storage: claimedFile(), prepare: (w) => { w.webkit.hachidori.databases = idbfs(GEN_A, GEN_B) } })
  assert.ok(!first.world.reports.some((r) => r.check === 'ext-host-storage-desync'))
  assert.ok(first.world.reports.some((r) => r.check === 'ext-host-storage-tagged' && r.tag === null))
  assert.equal(first.world.backups.length, 0)
  assert.equal(first.world.storage.hachidori.local.dictionaryState.dictionaries.length, 2)
  const marker = first.world.webkit.hachidori.localStorage.get('kimochi.extensionStore')
  assert.equal(first.world.storage.hachidori.host.store, marker)
  // Relaunch: same file, same store.
  const second = await hachidoriSession({
    storage: first.world.storage,
    prepare: (w) => { w.webkit.hachidori = first.world.webkit.hachidori }
  })
  assert.deepEqual({ ...second.started }, { ready: true })
  assert.ok(!second.world.reports.some((r) => /ext-host-storage-(desync|tagged)/.test(r.check)))
  assert.equal(second.world.storage.hachidori.local.dictionaryState.dictionaries.length, 2)
})

test('a file tagged by another store, whose dictionaries are not here, says other-store', async () => {
  const { world } = await hachidoriSession({
    storage: claimedFile({ store: 'S-THE-BUNDLE' }),
    prepare: (w) => {
      w.webkit.hachidori.localStorage.set('kimochi.extensionStore', 'S-THE-BARE-EXE')
      w.webkit.hachidori.databases = idbfs() // the mount exists, empty
    }
  })
  const desync = world.reports.find((r) => r.check === 'ext-host-storage-desync')
  assert.equal(desync.reason, 'other-store')
  assert.equal(desync.tag, 'S-THE-BUNDLE')
  assert.equal(desync.store, 'S-THE-BARE-EXE')
  assert.equal(desync.fresh, false)
  assert.deepEqual([...desync.missing], [GEN_A, GEN_B])
  assert.equal(world.storage.hachidori.host.store, 'S-THE-BARE-EXE')
})

test('a probe that cannot tell resets nothing', async () => {
  const { world, started } = await hachidoriSession({
    storage: claimedFile(),
    prepare: (w) => {
      const attach = w.attachStore.bind(w)
      w.attachStore = (win, store) => {
        attach(win, store)
        win.indexedDB.databases = undefined
      }
    }
  })
  assert.deepEqual({ ...started }, { ready: true })
  assert.ok(world.reports.some((r) => r.check === 'ext-host-storage-probe-failed' && /databases/.test(r.error)))
  assert.ok(!world.reports.some((r) => r.check === 'ext-host-storage-desync'))
  assert.equal(world.storage.hachidori.local.dictionaryState.dictionaries.length, 2)
  assert.equal(world.backups.length, 0)
})

test("10ten: lastDbUpdateTime without a jpdict database here is reset; with one it stays", async () => {
  const file = { tenten: { local: { enabled: true, lastDbUpdateTime: 1791794983805, settings: { a: 1 } }, sync: {}, host: { installed: { version: '1.28.0' } } } }
  const missing = await tentenSession({ storage: structuredClone(file) })
  const desync = missing.world.reports.find((r) => r.check === 'ext-host-storage-desync')
  assert.deepEqual([...desync.removed], ['lastDbUpdateTime'])
  assert.deepEqual([...desync.missing], ['jpdict'])
  assert.equal(missing.world.storage.tenten.local.lastDbUpdateTime, undefined)
  assert.equal(missing.world.storage.tenten.local.enabled, true)
  const present = await tentenSession({
    storage: structuredClone(file),
    prepare: (w) => { w.webkit.tenten.databases = { jpdict: { words: new Map([[1, {}]]), version: new Map() } } }
  })
  assert.ok(!present.world.reports.some((r) => r.check === 'ext-host-storage-desync'))
  assert.equal(present.world.storage.tenten.local.lastDbUpdateTime, 1791794983805)
})

// The storage file must never be replaced with an empty one because one read of it failed: it is
// the only list of the user's installed dictionaries (both engines share this hub code).
for (const engine of ['hachidori', 'tenten']) {
  const session = engine === 'hachidori' ? hachidoriSession : tentenSession
  const userFile = () =>
    engine === 'hachidori'
      ? claimedFile({ store: 'S-HERE' })
      : { tenten: { local: { enabled: true, lastDbUpdateTime: 1791794983805 }, sync: {}, host: { installed: { version: '1.28.0' }, store: 'S-HERE' } } }

  test(`${engine}: a storage file that cannot be read is never overwritten with the seed`, async () => {
    const { world, started } = await session({
      storage: userFile(),
      prepare: (w) => {
        w.loadFailures = Infinity
        w.webkit[engine].localStorage.set('kimochi.extensionStore', 'S-HERE')
      }
    })
    assert.deepEqual({ ...started }, { ready: true })
    const failed = world.reports.find((r) => r.check === 'ext-host-storage-load-failed')
    assert.equal(failed.action, 'read-only')
    assert.equal(world.invoked.filter((i) => i.command === 'storage_load').length, 3)
    // Not one write, not one reset, whatever the extension and the probe did this session.
    assert.equal(world.saves.length, 0)
    assert.equal(world.backups.length, 0)
    assert.ok(!world.reports.some((r) => r.check === 'ext-host-storage-desync' || r.check === 'ext-host-storage-seeded'))
    assert.deepEqual(world.storage[engine], userFile()[engine])
  })

  test(`${engine}: a read that fails once is retried and the user's file is used`, async () => {
    const { world, started } = await session({
      storage: userFile(),
      prepare: (w) => {
        w.loadFailures = 1
        w.webkit[engine].localStorage.set('kimochi.extensionStore', 'S-HERE')
        if (engine === 'hachidori') w.webkit.hachidori.databases = idbfs(GEN_A, GEN_B)
        else w.webkit.tenten.databases = { jpdict: { words: new Map([[1, {}]]), version: new Map() } }
      }
    })
    assert.deepEqual({ ...started }, { ready: true })
    assert.ok(!world.reports.some((r) => r.check === 'ext-host-storage-load-failed' || r.check === 'ext-host-storage-seeded'))
    if (engine === 'hachidori') assert.equal(world.storage.hachidori.local.dictionaryState.dictionaries.length, 2)
    else assert.equal(world.storage.tenten.local.lastDbUpdateTime, 1791794983805)
  })
}

test('a later launch fires onStartup instead of onInstalled', async () => {
  const storage = { hachidori: { local: {}, sync: {}, host: { installed: { version: HACHIDORI_VERSION } } } }
  const { background } = await hachidoriSession({ storage })
  await waitFor(() => result(background, 'lifecycle.length'), 'lifecycle event')
  assert.deepEqual(result(background, 'JSON.stringify(lifecycle)'), JSON.stringify(['startup']))
})

test('runtime.sendMessage follows Chrome: other extension contexts only, first answer wins', async () => {
  const { world, overlay, background, offscreen } = await hachidoriSession()
  const page = world.frame(overlay, 'hachidori://localhost/settings.html')
  result(overlay, 'globalThis.contentSaw = []; chrome.runtime.onMessage.addListener((m) => { contentSaw.push(m) })')
  result(page, 'globalThis.pageSaw = []; chrome.runtime.onMessage.addListener((m) => { pageSaw.push(m) })')
  await sleep(20)
  assert.equal(await result(page, 'chrome.runtime.sendMessage({ case: "race" })'), 'fast-offscreen')
  assert.deepEqual({ ...(await result(page, 'chrome.runtime.sendMessage({ case: "async-true" })')) }, { ok: 'later' })
  assert.equal(await result(page, 'chrome.runtime.sendMessage({ case: "promise" })'), 'from-promise')
  assert.equal(await result(page, 'chrome.runtime.sendMessage({ case: "nobody-answers" })'), undefined)
  // Callback form.
  const viaCallback = await result(page, 'new Promise((resolve) => chrome.runtime.sendMessage({ case: "promise" }, (r) => resolve([r, chrome.runtime.lastError])))')
  assert.equal(viaCallback[0], 'from-promise')
  assert.equal(viaCallback[1], undefined)
  // Never to content scripts, never back to the sender.
  assert.equal(result(overlay, 'contentSaw.length'), 0)
  assert.equal(result(page, 'pageSaw.length'), 0)
  // The background's own message reaches the offscreen document (and the page), not itself.
  await result(background, 'chrome.runtime.sendMessage({ case: "nobody-answers" })')
  assert.ok(result(offscreen, 'offscreenSeen.some((m) => m.case === "nobody-answers")'))
  assert.equal(result(page, 'pageSaw.length'), 1)
})

test('no listener anywhere rejects with Chrome\'s exact "Receiving end does not exist."', async () => {
  const { background } = await tentenSession()
  // 10ten has no offscreen document; with no extension page open there is nobody to receive.
  await assert.rejects(() => result(background, 'browser.runtime.sendMessage({ type: "x" })'), (error) => error.message === NO_RECEIVER)
  const lastError = await result(background, 'new Promise((resolve) => chrome.runtime.sendMessage({ type: "x" }, () => resolve(chrome.runtime.lastError?.message)))')
  assert.equal(lastError, NO_RECEIVER)
})

test('senders: content has tab, frameId 0 and documentId; extension pages have no tab and their exact URL', async () => {
  const { world, overlay, background, offscreen } = await hachidoriSession()
  const page = world.frame(overlay, 'hachidori://localhost/settings.html?tab=anki#x')
  await sleep(20)
  const fromPage = await result(page, 'chrome.runtime.sendMessage({ case: "sender" })')
  assert.equal(fromPage.url, 'hachidori://localhost/settings.html?tab=anki#x')
  assert.equal(fromPage.id, 'kimochi-hachidori')
  assert.equal(fromPage.tab, undefined)
  assert.equal(typeof fromPage.documentId, 'string')
  const fromContent = await result(overlay, 'chrome.runtime.sendMessage({ case: "sender" })')
  assert.equal(fromContent.tab.id, 1)
  assert.equal(fromContent.frameId, 0)
  assert.equal(typeof fromContent.documentId, 'string')
  assert.equal(fromContent.url, `${APP}/ui/overlay.html`)
  // The background's sender is its worker script, which offscreen.js compares exactly.
  const fromBackground = await result(background, 'chrome.runtime.sendMessage({ case: "bgsender" })')
  assert.equal(fromBackground.url, 'hachidori://localhost/background.js')
  assert.equal(fromBackground.tab, undefined)
  assert.ok(offscreen)
})

test("10ten's enable? → enable → enabled handshake reaches frame 0 of each window's tab", async () => {
  const { world, overlay } = await tentenSession()
  await waitFor(() => result(overlay, 'globalThis.enabledFrameId === 0'), 'overlay enabled')
  // The Log, over the relay.
  const log = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror: 'tenten', tauri: true }))
  const started = await result(log, '__kimochiExtensionHost.start({ scope: "[data-yomitan-scan]" })')
  assert.deepEqual({ ...started }, { ready: true })
  await waitFor(() => result(log, 'globalThis.enabledFrameId === 0'), 'log enabled')
  assert.notEqual(result(log, '__kimochiExtensionHost.tabId'), 1)
  const tabs = await result(overlay, 'browser.tabs.query({ active: true })')
  assert.equal(tabs[0].id, 1, 'overlay first')
  assert.ok(tabs.some((t) => t.id === result(log, '__kimochiExtensionHost.tabId')))
  assert.ok(tabs.every((t) => t.id !== 0))
  const windows = await result(overlay, 'browser.windows.getAll({ populate: true })')
  assert.equal(windows.length, 1)
  assert.equal(windows[0].tabs.length, tabs.length)
})

test('tabs.sendMessage routes by tab, frameId and documentId', async () => {
  const { overlay, background } = await tentenSession()
  await waitFor(() => result(overlay, 'globalThis.enabledFrameId === 0'), 'overlay enabled')
  assert.equal(await result(background, 'browser.tabs.sendMessage(1, { type: "ping", frame: 0 }, { frameId: 0 })'), 'ok')
  assert.equal(await result(background, 'browser.tabs.sendMessage(1, { type: "ping", frame: "*" })'), 'ok')
  await assert.rejects(() => result(background, 'browser.tabs.sendMessage(1, { type: "ping" }, { frameId: 7 })'), (e) => e.message === NO_RECEIVER)
  await assert.rejects(() => result(background, 'browser.tabs.sendMessage(424242, { type: "ping" })'), (e) => e.message === NO_RECEIVER)
  const sender = await result(overlay, 'browser.runtime.sendMessage({ type: "sender" })')
  assert.equal(await result(background, `browser.tabs.sendMessage(1, { type: "ping" }, { documentId: ${JSON.stringify(sender.documentId)} })`), 'ok')
  await assert.rejects(() => result(background, 'browser.tabs.sendMessage(1, { type: "ping" }, { documentId: "nope" })'), (e) => e.message === NO_RECEIVER)
})

// ---------------------------------------------------------------- storage

test('storage: get forms, onChanged area names, persistence with the extension argument, seed once', async () => {
  const { world, overlay, background } = await tentenSession()
  // Seeded on the first load of the file (10ten is off until toggled).
  assert.deepEqual({ ...(await result(overlay, 'browser.storage.local.get("enabled")')) }, { enabled: true })
  const firstSave = world.saves[0]
  assert.equal(firstSave.extension, 'tenten')
  assert.equal(firstSave.value.local.enabled, true)
  await result(background, 'browser.storage.local.set({ a: 1, b: { c: [2] } })')
  assert.deepEqual(JSON.parse(JSON.stringify(await result(overlay, 'browser.storage.local.get(null)'))), { enabled: true, a: 1, b: { c: [2] } })
  assert.deepEqual({ ...(await result(overlay, 'browser.storage.local.get(["a", "missing"])')) }, { a: 1 })
  assert.deepEqual({ ...(await result(overlay, 'browser.storage.local.get({ a: 0, z: 9 })')) }, { a: 1, z: 9 })
  assert.equal(typeof (await result(overlay, 'browser.storage.local.getBytesInUse(null)')), 'number')
  result(overlay, 'globalThis.changes = []; browser.storage.onChanged.addListener((c, area) => changes.push([area, c])); globalThis.syncOnly = []; browser.storage.sync.onChanged.addListener((c) => syncOnly.push(c))')
  await result(background, 'browser.storage.sync.set({ theme: "dark" })')
  await waitFor(() => result(overlay, 'changes.length'), 'onChanged')
  assert.equal(result(overlay, 'changes[0][0]'), 'sync')
  assert.equal(result(overlay, 'changes[0][1].theme.newValue'), 'dark')
  assert.equal(result(overlay, '"oldValue" in changes[0][1].theme'), false)
  assert.equal(result(overlay, 'syncOnly.length'), 1)
  const last = world.saves.at(-1)
  assert.equal(last.extension, 'tenten')
  assert.equal(last.value.sync.theme, 'dark')
  await result(background, 'browser.storage.local.remove("a")')
  assert.equal('a' in world.storage.tenten.local, false)
  // session is the hub's memory, never saved.
  const saves = world.saves.length
  await result(background, 'browser.storage.session.set({ s: 1 })')
  assert.equal(world.saves.length, saves)
  // The next launch finds the file and does not seed again.
  world.storage.tenten.local = {}
  const again = await tentenSession({ storage: { tenten: world.storage.tenten } })
  assert.deepEqual({ ...(await result(again.overlay, 'browser.storage.local.get("enabled")')) }, {})
})

// ---------------------------------------------------------------- ports

test('ports cross the iframe transport (Hachidori settings → background)', async () => {
  const { world, overlay } = await hachidoriSession()
  const page = world.frame(overlay, 'hachidori://localhost/settings.html')
  result(page, 'globalThis.got = []; globalThis.port = chrome.runtime.connect({ name: "hachidori-backup-settings" }); port.onMessage.addListener((m) => got.push(m)); port.postMessage({ type: "track", token: "t" })')
  await waitFor(() => result(page, 'got.length'), 'port echo')
  assert.equal(result(page, 'got[0].echo.token'), 't')
  assert.equal(result(page, 'got[0].name'), 'hachidori-backup-settings')
  assert.equal(result(page, 'got[0].sender.url'), 'hachidori://localhost/settings.html')
  result(page, 'port.disconnect()')
})

test('ports cross the ext_relay transport (Log content → overlay background)', async () => {
  const { world } = await tentenSession()
  const log = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror: 'tenten', tauri: true }))
  await result(log, '__kimochiExtensionHost.start({ scope: "[data-yomitan-scan]" })')
  result(log, 'globalThis.got = []; globalThis.port = browser.runtime.connect(undefined, { name: "options" }); port.onMessage.addListener((m) => got.push(m)); port.postMessage({ hello: 1 })')
  await waitFor(() => result(log, 'got.length'), 'relayed port echo')
  assert.equal(result(log, 'got[0].echo.hello'), 1)
  assert.equal(result(log, 'got[0].tab'), result(log, '__kimochiExtensionHost.tabId'))
  // Relayed payloads are namespaced so ui/overlay.js handleRelay ignores them.
  const relayed = world.invoked.filter((i) => i.command === 'ext_relay')
  assert.ok(relayed.length > 0)
  assert.ok(relayed.every((i) => i.args.payload.kind === 'ext' || i.args.payload.kind === 'navigate'))
})

test('a port nobody accepts disconnects with the receiving-end error', async () => {
  const { world, overlay } = await hachidoriSession()
  const page = world.frame(overlay, 'hachidori://localhost/settings.html')
  // The offscreen document has no onConnect listener; the background has one, so close it first.
  result(page, 'globalThis.why = null; const p = chrome.tabs.connect(99, { name: "x" }); p.onDisconnect.addListener(() => { why = chrome.runtime.lastError?.message ?? "none" })')
  await waitFor(() => result(page, 'why'), 'disconnect')
  assert.equal(result(page, 'why'), NO_RECEIVER)
})

// ---------------------------------------------------------------- i18n, alarms, absent APIs

test('i18n.getMessage substitutes named and numbered placeholders from _locales', async () => {
  const world = new World({ files: { 'tenten://localhost/_locales/en/messages.json': TENTEN_LOCALE } })
  const panel = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'dictionary', mirror: 'tenten' }))
  const options = world.window({ href: 'tenten://localhost/options.html', prelude: 'tenten', parent: panel })
  world.load(options)
  assert.equal(result(options, 'chrome.i18n.getMessage("content_copy_overlay_copy_title_with_word", ["選ぶ"])'), 'Copy 選ぶ')
  assert.equal(result(options, 'chrome.i18n.getMessage("command_toggle_downloading", ["radical data", "(12%)"])'), 'Downloading radical data  (12%)…')
  assert.equal(result(options, 'chrome.i18n.getMessage("CONTENT_COPY_OVERLAY_COPY_TITLE_WITH_WORD", "猫")'), 'Copy 猫')
  assert.equal(result(options, 'chrome.i18n.getMessage("no_such_key")'), '')
  assert.equal(result(options, 'chrome.i18n.getMessage("@@ui_locale")'), 'en')
})

test('alarms are absent for Hachidori and timer-backed for 10ten; absent namespaces stay absent', async () => {
  const h = await hachidoriSession()
  assert.equal(result(h.background, 'typeof chrome.alarms'), 'undefined')
  assert.equal(result(h.background, '"alarms" in chrome'), false)
  for (const name of ['downloads', 'scripting', 'userScripts', 'management', 'tabCapture', 'declarativeNetRequest', 'webRequest']) {
    assert.equal(result(h.background, `${JSON.stringify(name)} in chrome || chrome[${JSON.stringify(name)}] !== undefined`), false, name)
  }
  assert.equal(result(h.background, 'typeof chrome.runtime.getFrameId'), 'undefined')
  await waitFor(() => h.world.reports.some((r) => r.check === 'ext-host-absent-api' && r.api === 'downloads'), 'absent-api report')
  const t = await tentenSession()
  result(t.background, 'globalThis.fired = []; browser.alarms.onAlarm.addListener((a) => fired.push(a.name)); browser.alarms.create("soon", { when: Date.now() + 20 })')
  assert.equal((await result(t.background, 'browser.alarms.get("soon")')).name, 'soon')
  await waitFor(() => result(t.background, 'fired.length'), 'alarm')
  assert.equal(result(t.background, 'fired[0]'), 'soon')
  assert.equal(result(t.background, 'Boolean(browser.runtime.id) && browser === chrome'), true)
  // contextMenus.create runs its callback without lastError (10ten context-menus.ts).
  assert.equal(await result(t.background, 'new Promise((r) => chrome.contextMenus.create({ id: "m" }, () => r(chrome.runtime.lastError === undefined)))'), true)
})

// ---------------------------------------------------------------- scan scope, opening pages

test('the scan scope filters the extension\'s hit tests only, and setEnabled(false) blanks them', async () => {
  const { world, background } = await tentenSession()
  const log = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror: 'tenten', tauri: true }))
  await result(log, '__kimochiExtensionHost.start({ scope: "[data-yomitan-scan]" })')
  result(log, `
    const line = document.createElement('p'); line.__matches = ['[data-yomitan-scan]']
    const word = document.createElement('span'); word.parentNode = line
    const chrome_ui = document.createElement('button')
    const popup = document.createElement('div'); popup.__matches = ['#tenten-ja-window']
    __hits = [{ x0: 0, x1: 100, y0: 0, y1: 100, el: word }, { x0: 200, x1: 300, y0: 0, y1: 100, el: chrome_ui }, { x0: 400, x1: 500, y0: 0, y1: 100, el: popup }]
  `)
  const asExtension = (code) => world.run(log, code, 'tenten://localhost/10ten-ja-content.js')
  assert.notEqual(asExtension('document.caretRangeFromPoint(10, 10)'), null, 'inside the scope')
  assert.equal(asExtension('document.caretRangeFromPoint(210, 10)'), null, 'outside the scope')
  assert.equal(asExtension('document.caretPositionFromPoint(210, 10)'), null)
  assert.equal(asExtension('document.elementFromPoint(210, 10)'), null)
  assert.equal(asExtension('document.elementsFromPoint(210, 10).length'), 0)
  assert.notEqual(asExtension('document.elementFromPoint(410, 10)'), null, 'the popup itself stays reachable')
  // Kimochi's own UI keeps real answers.
  assert.notEqual(result(log, 'document.elementFromPoint(210, 10)'), null)
  result(log, '__kimochiExtensionHost.setEnabled(false)')
  assert.equal(asExtension('document.caretRangeFromPoint(10, 10)'), null, 'disabled')
  result(log, '__kimochiExtensionHost.setEnabled(true)')
  assert.notEqual(asExtension('document.caretRangeFromPoint(10, 10)'), null)
  result(background, `dataPort.postMessage({ type: 'dbstateupdated', state: {
    words: { state: 'empty' }, updateState: { type: 'updating', series: 'words', totalProgress: 0.4 }
  } })`)
  await waitFor(
    () => world.reports.filter((r) => r.check === 'dictionary-readiness').at(-1)?.phase === 'downloading',
    'the download is reported'
  )
  const downloading = world.reports.filter((r) => r.check === 'dictionary-readiness').at(-1)
  assert.equal(downloading.settingsReady, true, '10ten settings remain usable during data downloads')
  assert.equal(downloading.lookups, true)
  // 10ten reads its bundled words (data/words.ljson) while the full dictionary downloads.
  assert.notEqual(asExtension('document.caretRangeFromPoint(10, 10)'), null, 'lookups go on while data downloads')
  result(log, '__kimochiExtensionHost.setEnabled(false)')
  assert.equal(asExtension('document.caretRangeFromPoint(10, 10)'), null, 'the switch still turns them off')
  result(log, '__kimochiExtensionHost.setEnabled(true)')
  result(background, `dataPort.postMessage({ type: 'dbstateupdated', state: {
    words: { state: 'ok' }, kanji: { state: 'ok' }, radicals: { state: 'ok' }, names: { state: 'ok' }, updateState: { type: 'idle' }
  } })`)
  await waitFor(() => world.reports.filter((r) => r.check === 'dictionary-readiness').at(-1)?.phase === 'ready', 'ready')
  assert.notEqual(asExtension('document.caretRangeFromPoint(10, 10)'), null)
})

test('Hachidori installer broadcasts gate lookup and report byte progress without changing the messages', async () => {
  const { world, overlay, offscreen } = await hachidoriSession()
  await result(offscreen, `chrome.runtime.sendMessage({ target: 'hachidori-setup-events', type: 'hd_setup_progress',
    runId: 'setup-1', sequence: 1, finished: false, entries: [{ phase: 'downloading', receivedBytes: 30, totalBytes: 100 }]
  }).catch(() => {})`)
  await waitFor(() => world.reports.some((r) => r.check === 'dictionary-readiness' && r.progress === 30), 'installer progress')
  assert.equal(await result(overlay, '__kimochiExtensionHost.lookupRange(null)'), false, 'lookups wait for installation')
  await result(offscreen, `chrome.runtime.sendMessage({ target: 'hachidori-setup-events', type: 'hd_setup_progress',
    runId: 'setup-1', sequence: 2, finished: true, entries: [{ phase: 'installed' }]
  }).catch(() => {})`)
  await waitFor(() => world.reports.filter((r) => r.check === 'dictionary-readiness').at(-1)?.phase === 'ready', 'installation recovery')
})

test('openOptionsPage shows the dictionary panel and relays navigate; the panel hands it to React', async () => {
  const { world, overlay, background } = await tentenSession({ panels: true })
  const dictionary = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'dictionary', mirror: 'tenten', tauri: true }))
  result(dictionary, 'globalThis.navigated = []; addEventListener("kimochi-dictionary-navigate", (e) => navigated.push(e.detail.url))')
  await result(background, 'browser.runtime.openOptionsPage()')
  assert.ok(world.invoked.some((i) => i.command === 'panel' && i.args.label === 'dictionary' && i.args.action === 'show'))
  await waitFor(() => result(dictionary, 'navigated.length'), 'navigate event')
  assert.equal(result(dictionary, 'navigated[0]'), 'tenten://localhost/options.html')
  assert.equal(result(dictionary, '__kimochiExtensionHost.pendingNavigate'), 'tenten://localhost/options.html')
  // A navigate to anything but the engine's origin is refused.
  await world.invoke('overlay', 'ext_relay', { target: 'dictionary', payload: { kind: 'navigate', url: 'https://example.com/' } })
  await sleep(20)
  assert.equal(result(dictionary, 'navigated.length'), 1)
  assert.ok(overlay)
})

test('without native panels the page is offered to the hub document instead', async () => {
  const { overlay, background } = await hachidoriSession()
  result(overlay, 'globalThis.navigated = []; addEventListener("kimochi-dictionary-navigate", (e) => navigated.push(e.detail.url))')
  const tab = await result(background, 'chrome.tabs.create({ url: chrome.runtime.getURL("startup.html") })')
  assert.equal(tab.url, 'hachidori://localhost/startup.html')
  assert.equal(result(overlay, 'navigated[0]'), 'hachidori://localhost/startup.html')
})

test('remote fetches from extension frames go through the parent and keep the final URL', async () => {
  const { world, background } = await tentenSession()
  world.remote = async (url) => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/zip' } })
    Object.defineProperty(response, 'url', { value: url.replace('github.com', 'objects.githubusercontent.com') })
    return response
  }
  const out = await result(background, `fetch('https://github.com/x/releases/download/a.zip').then(async (r) => [r.status, r.url, r.headers.get('content-type'), [...new Uint8Array(await r.arrayBuffer())]])`)
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [200, 'https://objects.githubusercontent.com/x/releases/download/a.zip', 'application/zip', [1, 2, 3, 4]])
  // Bugsnag is refused, and said so.
  await assert.rejects(() => result(background, "fetch('https://notify.bugsnag.com/')"))
  await waitFor(() => world.reports.some((r) => r.check === 'ext-host-host-refused' && r.host === 'notify.bugsnag.com'), 'refusal report')
})

test("lookupRange, popupControl and dismiss drive Hachidori's hd_reader_command in the content context", async () => {
  const { overlay } = await hachidoriSession()
  result(overlay, `
    globalThis.selected = []
    getSelection = () => ({ removeAllRanges() {}, addRange(r) { selected.push(r.text) } })
    globalThis.HDReaderReady = Promise.resolve({ scanSelectedText: () => false })
  `)
  const range = '({ text: "食べました", startContainer: { nodeType: 3, parentElement: document.body }, getClientRects: () => [{ left: 10, top: 10, width: 40, height: 20 }], getBoundingClientRect: () => ({ left: 10, top: 10, width: 40, height: 20 }) })'
  assert.equal(await result(overlay, `__kimochiExtensionHost.lookupRange(${range})`), true)
  assert.deepEqual([...result(overlay, 'selected')], ['食べました'])
  assert.equal(result(overlay, 'readerCommands[0]'), 'scanTextAtSelection')
  result(overlay, '__kimochiExtensionHost.popupControl({ step: 1 }); __kimochiExtensionHost.popupControl({ step: -1 }); __kimochiExtensionHost.dismiss()')
  await waitFor(() => result(overlay, 'readerCommands.length >= 4'), 'reader commands')
  assert.deepEqual([...result(overlay, 'readerCommands')], ['scanTextAtSelection', 'nextEntry', 'previousEntry', 'close'])
  assert.equal(result(overlay, '__kimochiExtensionHost.isPopupVisible()'), false)
})

test('lookupRange answers false where no content scripts run', async () => {
  const world = new World()
  const dictionary = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'dictionary', mirror: 'tenten' }))
  assert.equal(await result(dictionary, '__kimochiExtensionHost.lookupRange({})'), false)
})

// ---------------------------------------------------------------- document-start install

test('installing before documentElement exists does not throw; the background <base> comes later', async () => {
  // WebView2 runs native's document-start script before `document.documentElement` exists.
  const world = new World({ engine: 'tenten', files: { [`${ORIGINS.tenten}/_locales/en/messages.json`]: TENTEN_LOCALE }, scripts: { [`${ORIGINS.tenten}/10ten-ja-background.js`]: TENTEN.background } })
  const overlay = world.load(world.window({ href: `${APP}/ui/overlay.html`, label: 'overlay', mirror: 'tenten', tauri: true }))
  const background = world.window({ href: `${ORIGINS.tenten}/__kimochi/ext-background.html?engine=tenten`, prelude: 'tenten', parent: overlay })
  vm.runInContext('document.documentElement = null; document.head = null; document.readyState = "loading"; document.addEventListener = (type, f) => { if (type === "DOMContentLoaded") globalThis.__parsed = f }', background)
  world.load(background)
  assert.equal(result(background, 'typeof chrome.runtime.getURL'), 'function')
  assert.equal(result(background, 'window.__kimochiExtensionHost.kind'), 'background')
  // Once parsed, the <base> goes in first, then the background script (10ten resolves
  // `./10ten-ja-jpdict.js` against it).
  vm.runInContext('document.head = new Element("head"); document.documentElement = new Element("html"); document.readyState = "interactive"; __parsed()', background)
  assert.deepEqual([...result(background, 'document.head.children.map((e) => e.localName)')].slice(0, 2), ['base', 'script'])
  assert.equal(result(background, 'document.head.children[0].href'), `${ORIGINS.tenten}/`)
  await waitFor(() => result(background, 'Array.isArray(globalThis.lifecycle)'), 'the background script ran')
})

test('a failed install clears the guard so a later copy of the host can install', () => {
  const world = new World()
  const win = world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror: 'tenten' })
  const location = win.location
  let calls = 0
  // The first read is World.load's (the script's file name); the second is the host's.
  Object.defineProperty(win, 'location', { configurable: true, get: () => (calls++ === 1 ? (() => { throw Error('not yet') })() : location) })
  world.load(win)
  assert.equal(result(win, 'typeof __kimochiExtensionHost'), 'undefined')
  assert.equal(result(win, 'window.__kimochiExtHostInstalling'), false)
  world.load(win)
  assert.equal(result(win, '__kimochiExtensionHost.engine'), 'tenten')
})

test('each engine names the pointer events its scanner listens for, and lookupRange sends those', async () => {
  const world = new World()
  const h = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror: 'hachidori' }))
  assert.deepEqual([...result(h, '__kimochiExtensionHost.descriptor.pointerEvents')], ['mousemove'])
  const t = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror: 'tenten' }))
  assert.deepEqual([...result(t, '__kimochiExtensionHost.descriptor.pointerEvents')], ['pointermove'])
  const { overlay } = await tentenSession()
  result(overlay, 'globalThis.moves = []; document.body.dispatchEvent = (e) => { moves.push([e.type, e.fromPuck]); return true }')
  const range = '({ startContainer: document.body, getClientRects: () => [{ left: 10, top: 10, width: 40, height: 20 }], getBoundingClientRect: () => ({ left: 10, top: 10, width: 40, height: 20 }) })'
  assert.equal(await result(overlay, `__kimochiExtensionHost.lookupRange(${range})`), true)
  assert.deepEqual(JSON.parse(JSON.stringify(result(overlay, 'moves'))), [['pointermove', true]])
})

// ---------------------------------------------------------------- the worker fetch shim

test("a module worker's remote fetch goes through its frame, streams, keeps the final URL, and early messages wait for the script", async () => {
  const shimBuild = await build({
    stdin: {
      contents: "export { installWorkerNetwork, runWorkerShim, WORKER_SHIM_PATH } from './host/ext/worker-network.js'; export { createNetworkServer } from './host/ext/network.js'",
      resolveDir: fileURLToPath(root),
      loader: 'js'
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'safari17',
    write: false,
    logLevel: 'silent'
  })
  const shim = await import(`data:text/javascript;base64,${Buffer.from(shimBuild.outputFiles[0].text).toString('base64')}`)
  const origin = 'hachidori://localhost'
  const remote = []
  /** A worker realm: its own EventTarget global, `postMessage` back to the creator. */
  const workerScope = (href, creator) => {
    const scope = new EventTarget()
    Object.assign(scope, {
      location: { href, origin },
      URL, Request, Response, Headers, ReadableStream, DOMException, MessageChannel: TrackedChannel, MessageEvent, AbortController,
      fetch: async () => new Response('local'),
      postMessage: (data) => setTimeout(() => creator.dispatchEvent(new MessageEvent('message', { data })), 0)
    })
    return scope
  }
  const workers = []
  // Node's MessagePorts keep the process alive until closed; every one made here is closed at the end.
  const channels = []
  class TrackedChannel extends MessageChannel {
    constructor() {
      super()
      channels.push(this)
    }
  }
  // The real worker script: answers {go} with what its fetch saw; registered at evaluation.
  const scripts = {
    [`${origin}/engine-worker.js`]: (scope) => {
      scope.addEventListener('message', async (event) => {
        if (!event.data?.go) return
        const response = await scope.fetch(event.data.go)
        const bytes = [...new Uint8Array(await response.arrayBuffer())]
        scope.postMessage({ status: response.status, url: response.url, redirected: response.redirected, bytes })
      })
    }
  }
  class FakeWorker extends EventTarget {
    constructor(url, options) {
      super()
      this.url = url
      this.options = options
      this.scope = workerScope(url, this)
      workers.push(this)
      // The shim's evaluation; the real script arrives later, as a module graph would.
      if (String(url).includes(shim.WORKER_SHIM_PATH)) void shim.runWorkerShim(this.scope, { load: (src) => new Promise((resolve) => setTimeout(() => resolve(scripts[src](this.scope)), 30)) })
    }

    postMessage(data, transfer = []) {
      const ports = transfer.filter((t) => t instanceof MessagePort)
      setTimeout(() => this.scope.dispatchEvent(new MessageEvent('message', { data, ports })), 0)
    }

    terminate() {}
  }
  // The frame: its `fetch` is the relayed one (the parent's plugin-http, here a stand-in that
  // follows a redirect).
  const frame = {
    location: { href: `${origin}/offscreen.html`, origin },
    document: { baseURI: `${origin}/offscreen.html` },
    MessageChannel: TrackedChannel,
    Worker: FakeWorker,
    fetch: async (url) => {
      remote.push(url)
      const response = new Response(new Uint8Array([5, 6, 7]), { status: 200 })
      Object.defineProperty(response, 'url', { value: url.replace('/latest/download/', '/download/v1/') })
      return response
    }
  }
  const reports = []
  shim.installWorkerNetwork(frame, {
    origin,
    report: (r) => reports.push(r),
    server: shim.createNetworkServer(frame, { denied: [], report: (r) => reports.push(r), fetch: (url, init) => frame.fetch(url, init) })
  })
  const worker = new frame.Worker('./engine-worker.js', { type: 'module', name: 'hoshidicts' })
  assert.ok(worker instanceof FakeWorker)
  assert.equal(worker.url, `${origin}${shim.WORKER_SHIM_PATH}?src=${encodeURIComponent(`${origin}/engine-worker.js`)}`)
  assert.equal(worker.options.name, 'hoshidicts')
  const answer = new Promise((resolve) => worker.addEventListener('message', (event) => resolve(event.data)))
  // Sent before the real script has loaded: held, then delivered to its listener.
  worker.postMessage({ go: 'https://github.com/a/b/releases/latest/download/d.zip' })
  const data = await answer
  assert.deepEqual(data, { status: 200, url: 'https://github.com/a/b/releases/download/v1/d.zip', redirected: true, bytes: [5, 6, 7] })
  assert.deepEqual(remote, ['https://github.com/a/b/releases/latest/download/d.zip'])
  // Classic, blob and cross-origin workers start as they are.
  assert.equal(new frame.Worker('./10ten-ja-jpdict.js').url, './10ten-ja-jpdict.js')
  assert.equal(new frame.Worker('blob:hachidori://localhost/x', { type: 'module' }).url, 'blob:hachidori://localhost/x')
  for (const channel of channels) {
    channel.port1.close()
    channel.port2.close()
  }
})

test('lookupRange meets the same enable switch and scope as a pointer lookup', async () => {
  const { overlay } = await hachidoriSession()
  result(overlay, 'getSelection = () => ({ removeAllRanges() {}, addRange() {} }); globalThis.HDReaderReady = Promise.resolve({ scanSelectedText: () => false })')
  const range = '({ startContainer: { nodeType: 3, parentElement: document.body }, getClientRects: () => [{ left: 10, top: 10, width: 40, height: 20 }], getBoundingClientRect: () => ({ left: 10, top: 10, width: 40, height: 20 }) })'
  result(overlay, '__kimochiExtensionHost.setEnabled(false)')
  assert.equal(await result(overlay, `__kimochiExtensionHost.lookupRange(${range})`), false)
  assert.equal(result(overlay, 'readerCommands.length'), 0)
})

// ---------------------------------------------------------------- WebKit IDBFS Blob records

async function importWorkerNetwork() {
  const out = await build({
    stdin: { contents: "export * from './host/ext/worker-network.js'", resolveDir: fileURLToPath(root), loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'safari17',
    write: false,
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

/** A worker global with the two things the adapter touches: `Blob` and `IDBObjectStore`. */
function idbScope(userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)') {
  const stored = []
  class IDBObjectStore {
    put(value, key) {
      stored.push({ method: 'put', value, key })
      return { readyState: 'pending' }
    }

    add(value, key) {
      stored.push({ method: 'add', value, key })
      return { readyState: 'pending' }
    }
  }
  return { scope: { Blob, IDBObjectStore, navigator: { userAgent } }, stored }
}

test('WebKit: IDBFS records of freshly written large files are stored as bytes, every other Blob as it is', async () => {
  const shim = await importWorkerNetwork()
  const NativeBlob = Blob
  const { scope, stored } = idbScope()
  assert.equal(shim.keepIdbRecordsAsBytes(scope, { minBytes: 8 }), true)
  assert.equal(shim.keepIdbRecordsAsBytes(scope, { minBytes: 8 }), false, 'installs once')
  const store = new scope.IDBObjectStore()

  // engine-service.js storeRemoteEntry: `{...entry, contents: new Blob([entry.contents])}`.
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const timestamp = new Date(0)
  const blob = new scope.Blob([bytes])
  assert.ok(blob instanceof scope.Blob && blob instanceof NativeBlob)
  assert.equal(blob.size, 10)
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [...bytes], 'the Blob itself is a real Blob')
  store.put({ timestamp, mode: 33206, contents: blob }, '/dicts/g/Jitendex/blobs.bin')
  assert.equal(stored[0].value.contents, bytes, 'the record carries the bytes the Blob was made from')
  assert.equal(stored[0].value.timestamp, timestamp)
  assert.equal(stored[0].value.mode, 33206)
  assert.equal(stored[0].key, '/dicts/g/Jitendex/blobs.bin')

  // Small files, several parts, Blobs from elsewhere (IndexedDB, slice, the native constructor).
  const small = new scope.Blob([new Uint8Array([1, 2])])
  const parts = new scope.Blob([new Uint8Array(8), new Uint8Array(8)])
  const native = new NativeBlob([new Uint8Array(16)])
  const sliced = blob.slice(0, 9)
  for (const contents of [small, parts, native, sliced]) {
    store.add({ contents }, 'k')
    assert.equal(stored.at(-1).value.contents, contents)
    assert.ok(contents instanceof scope.Blob, 'Blobs made elsewhere still pass `instanceof Blob`')
  }
  store.put(bytes, 'raw')
  assert.equal(stored.at(-1).value, bytes)
  store.put(undefined, 'none')
  assert.equal(stored.at(-1).value, undefined)
  assert.equal(typeof scope.Blob, 'function')
})

test('the IDB adapter runs in WebKit workers only; Chromium keeps Hachidori\'s Blob records', async () => {
  const shim = await importWorkerNetwork()
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
  const edge = `${chrome} Edg/141.0.0.0`
  assert.equal(shim.isWebKit({ userAgent: safari }), true)
  assert.equal(shim.isWebKit({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)' }), true, 'WebKitGTK')
  assert.equal(shim.isWebKit({ userAgent: chrome }), false)
  assert.equal(shim.isWebKit({ userAgent: edge }), false, 'WebView2')
  assert.equal(shim.isWebKit(undefined), false)

  for (const [userAgent, adapted] of [[safari, true], [chrome, false]]) {
    const { scope } = idbScope(userAgent)
    const NativeBlob = scope.Blob
    Object.assign(scope, {
      location: { href: 'hachidori://localhost/__kimochi/ext-worker.js?src=hachidori%3A%2F%2Flocalhost%2Fengine-worker-local.js' },
      URL,
      Request,
      Response,
      Headers,
      ReadableStream,
      DOMException,
      MessageEvent,
      fetch: async () => new Response(''),
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {}
    })
    await shim.runWorkerShim(scope, { load: async () => {} })
    assert.equal(scope.Blob !== NativeBlob, adapted, userAgent)
  }
})

// ---------------------------------------------------------------- the harness's plugin-http stand-in

test('the dev proxy: plugin-http scope globs, loopback only, final URL and upstream status passed back', async () => {
  const { createProxyMiddleware, scopeFromCapability, scopeAllows } = await import('./ext-dev-server.mjs')
  const capability = JSON.parse(await readFile(new URL('src-tauri/capabilities/network.json', root), 'utf8'))
  const scope = scopeFromCapability(capability)
  assert.equal(scopeAllows(scope, 'https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip'), true)
  assert.equal(scopeAllows(scope, 'https://release-assets.githubusercontent.com/github-production-release-asset/1/x?sig=y'), true)
  assert.equal(scopeAllows(scope, 'https://api.jiten.moe/api/frequency-list/download?downloadType=yomitan'), true)
  assert.equal(scopeAllows(scope, 'https://example.com/'), false)
  assert.equal(scopeAllows(scope, 'https://github.com.evil.example/'), false)

  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect })
    const response = new Response(new Uint8Array([1, 2, 3]), { status: 200, statusText: 'OK', headers: { 'content-length': '3' } })
    Object.defineProperty(response, 'url', { value: 'https://release-assets.githubusercontent.com/a?rscd=x' })
    return response
  }
  const middleware = createProxyMiddleware({ scope, fetchImpl })
  const run = (url, { remoteAddress = '127.0.0.1', method = 'GET', headers = {} } = {}) =>
    new Promise((resolve) => {
      const res = new (class extends EventTarget {
        constructor() {
          super()
          this.statusCode = 200
          this.headers = {}
          this.chunks = []
          this.writableFinished = false
        }

        setHeader(k, v) {
          this.headers[k.toLowerCase()] = v
        }

        on() {}
        once() {}
        write(chunk) {
          this.chunks.push(Buffer.from(chunk))
          return true
        }

        end(chunk) {
          if (chunk) this.chunks.push(Buffer.from(chunk))
          this.writableFinished = true
          resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(this.chunks) })
        }

        destroy(error) {
          resolve({ error })
        }
      })()
      const req = { url, method, headers, socket: { remoteAddress } }
      void middleware(req, res, () => resolve({ next: true }))
    })

  assert.deepEqual(await run('/somewhere/else'), { next: true })
  const target = encodeURIComponent('https://github.com/a/b/releases/latest/download/d.zip')
  assert.equal((await run(`/__kimochi/proxy?url=${target}`, { remoteAddress: '192.168.1.5' })).status, 403)
  const refused = await run(`/__kimochi/proxy?url=${encodeURIComponent('https://example.com/x')}`)
  assert.equal(refused.status, 403)
  assert.match(refused.body.toString(), /url not allowed on the configured scope/)
  assert.equal(calls.length, 0)

  const ok = await run(`/__kimochi/proxy?url=${target}`, { headers: { 'x-kimochi-forward-headers': JSON.stringify([['accept', '*/*'], ['origin', 'x'], ['cookie', 'y']]) } })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['x-kimochi-status'], '200')
  assert.equal(ok.headers['x-kimochi-final-url'], 'https://release-assets.githubusercontent.com/a?rscd=x')
  assert.deepEqual(JSON.parse(decodeURIComponent(ok.headers['x-kimochi-headers'])), [['content-length', '3']])
  assert.deepEqual([...ok.body], [1, 2, 3])
  assert.equal(calls[0].redirect, 'follow')
  assert.equal(calls[0].headers['accept-encoding'], 'identity', 'no compression, as reqwest without gzip')
  assert.equal(calls[0].headers.accept, '*/*')
  assert.equal(calls[0].headers.origin, undefined, 'forbidden headers are dropped as plugin-http drops them')
  assert.equal(calls[0].headers.cookie, undefined)
})

// ---------------------------------------------------------------- tabs.captureVisibleTab

/** A PNG's first bytes are enough: the host passes a PNG through without decoding it. */
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`

/** `capture:` frames served to `win`, and a canvas that records how it was asked to encode. */
function serveFrames(win, { gone = 0 } = {}) {
  const served = { fetches: [], encodes: [], gone }
  win.__served = served
  const realFetch = win.fetch
  win.fetch = async (input) => {
    const url = String(input)
    if (!url.startsWith('capture://')) return realFetch(input)
    served.fetches.push(url)
    if (served.gone > 0) {
      served.gone -= 1
      return new Response('', { status: 404 })
    }
    return new Response(new Uint8Array(PNG_BYTES), { headers: { 'content-type': 'image/png' } })
  }
  win.createImageBitmap = async (blob) => ({ width: 64, height: 36, type: blob.type, close() {} })
  world_run(win, `
    const realCreate = document.createElement.bind(document)
    document.createElement = (tag) => {
      if (tag !== 'canvas') return realCreate(tag)
      const ops = []
      return {
        width: 0, height: 0,
        getContext: () => ({ set fillStyle(v) { ops.push('fill ' + v) }, fillRect() { ops.push('fillRect') }, drawImage(b) { ops.push('draw ' + b.width + 'x' + b.height) } }),
        toBlob(callback, type, quality) {
          __served.encodes.push({ type, quality, ops, size: [this.width, this.height] })
          callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type }))
        }
      }
    }
  `)
  return served
}
function world_run(win, code) {
  return vm.runInContext(code, win)
}

test('captureVisibleTab answers with the captured source frame, not the overlay, in the format asked', async () => {
  const { world, overlay, background } = await hachidoriSession()
  const served = serveFrames(overlay)
  // The reading tab: the overlay's content context messages the extension.
  await result(overlay, 'chrome.runtime.sendMessage({ case: "sender" })')

  // Nothing captured yet: Chrome's prefix, so Hachidori adds the note without its picture.
  await assert.rejects(
    () => result(background, 'chrome.tabs.captureVisibleTab(1, { format: "jpeg" })'),
    (e) => /^Failed to capture tab: /.test(e.message) && !/per second|too many|MAX_CAPTURE/i.test(e.message)
  )

  world.frameSource = (scan) => ({ id: 5, url: 'capture://localhost/5', matched: false, scan })
  // background-anki.js: `captureVisibleTab(tab.windowId, { format: "jpeg" })`, no quality.
  const jpeg = await result(background, 'chrome.tabs.captureVisibleTab(1, { format: "jpeg" })')
  assert.ok(jpeg.startsWith('data:image/jpeg;base64,/9j/'), 'the exact prefix anki-worker.js accepts')
  assert.deepEqual(served.fetches, ['capture://localhost/5'])
  assert.equal(served.encodes[0].type, 'image/jpeg')
  assert.equal(served.encodes[0].quality, 0.9, "Chromium's default JPEG quality")
  assert.deepEqual([...served.encodes[0].size], [64, 36])
  assert.deepEqual([...served.encodes[0].ops], ['fill #000', 'fillRect', 'draw 64x36'], 'JPEG over black, at the frame size')

  await result(background, 'chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 40 })')
  assert.equal(served.encodes[1].quality, 0.4, 'quality honoured; windowId optional')
  // PNG of a PNG frame passes through byte for byte; PNG is also the shape the callback form gets.
  const png = await new Promise((resolve) => result(background, 'chrome.tabs.captureVisibleTab')(-2, { format: 'png' }, resolve))
  assert.equal(png, PNG_DATA_URL)
  assert.equal(served.encodes.length, 2, 'no canvas for PNG → PNG')

  await assert.rejects(() => result(background, 'chrome.tabs.captureVisibleTab(9, {})'), /No window with id: 9\./)
  await assert.rejects(() => result(background, 'chrome.tabs.captureVisibleTab(1, { format: "webp" })'), /Value must be one of jpeg, png/)
  await assert.rejects(() => result(background, 'chrome.tabs.captureVisibleTab(1, { quality: 101 })'), /between 0 and 100/)

  // The frame was held across each fetch and let go after, and no capture asked for a scan.
  const retains = world.invoked.filter((i) => i.command === 'retain_frame').map((i) => i.args.retain)
  assert.deepEqual(retains.slice(0, 2), [true, false])
  assert.ok(world.invoked.filter((i) => i.command === 'capture_frame_source').every((i) => i.args.scan === null))
  // Reported by size, never by content.
  const captures = world.reports.filter((r) => r.check === 'ext-host-capture')
  assert.equal(captures.filter((r) => r.ok).length, 3)
  assert.equal(captures.find((r) => r.ok).tab, 1)
  assert.ok(captures.find((r) => r.ok).bytes > 0)
  assert.ok(!JSON.stringify(world.reports).includes('base64'), 'no pixels in diagnostics')
})

test("from the Log, captureVisibleTab asks for the frame of the transcript line being read, and retries an evicted frame", async () => {
  const { world, overlay, background } = await hachidoriSession()
  const log = world.load(world.window({ href: `${APP}/app/panel.html`, label: 'log', mirror: 'hachidori', tauri: true }))
  assert.deepEqual({ ...(await result(log, '__kimochiExtensionHost.start({ scope: "[data-yomitan-scan]" })')) }, { ready: true })
  const served = serveFrames(overlay, { gone: 1 })
  world.frameSource = (scan) => ({ id: scan === 'S1' ? 3 : 9, url: `capture://localhost/${scan === 'S1' ? 3 : 9}`, matched: scan === 'S1' })
  result(log, `
    const line = document.createElement('div')
    line.__matches = ['[data-yomitan-scan]', '[data-ocr-scan]']
    line.setAttribute('data-ocr-scan', 'S1')
    const word = document.createElement('span'); word.parentNode = line
    __hits = [{ x0: 0, x1: 100, y0: 0, y1: 100, el: word }]
  `)
  // Hachidori's scanner hit-tests the line, then its reader messages the background.
  world.run(log, 'document.caretRangeFromPoint(10, 10)', 'hachidori://localhost/content-scan.js')
  await result(log, 'chrome.runtime.sendMessage({ case: "sender" })')
  const jpeg = await result(background, 'chrome.tabs.captureVisibleTab(1, { format: "jpeg" })')
  assert.ok(jpeg.startsWith('data:image/jpeg;base64,'))
  const asked = world.invoked.filter((i) => i.command === 'capture_frame_source').map((i) => i.args.scan)
  assert.deepEqual(asked, ['S1', 'S1'], 'asked again after the first fetch found the frame gone')
  assert.deepEqual(served.fetches, ['capture://localhost/3', 'capture://localhost/3'])
  const report = world.reports.find((r) => r.check === 'ext-host-capture' && r.ok)
  assert.equal(report.scan, 'S1')
  assert.equal(report.matched, true)
  assert.equal(report.tab, result(log, '__kimochiExtensionHost.tabId'))

  // Back on the overlay, the capture is the overlay's again: no scan, the frame on screen.
  await result(overlay, 'chrome.runtime.sendMessage({ case: "sender" })')
  await result(background, 'chrome.tabs.captureVisibleTab(1, { format: "jpeg" })')
  assert.equal(world.invoked.filter((i) => i.command === 'capture_frame_source').at(-1).args.scan, null)
})
