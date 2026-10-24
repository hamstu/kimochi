/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * Built-in Yomitan's own pages as Kimochi hosts them (host/page-actions.js, wired in by
 * host/yomitan/common.js): web links go to the system browser instead of loading inside the
 * settings window (or doing nothing, WKWebView's answer to `target=_blank`), an extension page
 * asked for in a new tab opens in the dictionary window, browser-internal links are dropped, and
 * Yomitan's blob downloads (settings backup, dictionary collection, Anki deck) reach the native
 * save dialog. The bundle tests run the real `dist/spike/panel-shim.js` in `node:vm`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import {
  classifyLink,
  installDownloads,
  installFileDropGuard,
  installPageLinks,
  isExtensionPage
} from '../host/page-actions.js'
import { yomitanShimSource } from './yomitan-shims.mjs'

const SETTINGS = 'tauri://localhost/settings.html'

test('links are sorted into web pages, extension pages, dead ends and the page\'s own business', () => {
  const kind = (href, base = SETTINGS) => classifyLink(href, base).kind
  assert.equal(kind('https://yomitan.wiki/anki/'), 'web')
  assert.equal(kind('http://127.0.0.1:8765'), 'web')
  assert.equal(kind('/search.html'), 'page')
  assert.equal(kind('info.html'), 'page')
  assert.equal(kind('#anki'), 'page')
  assert.equal(kind('tauri://localhost/welcome.html'), 'page')
  for (const href of ['chrome://extensions/shortcuts', 'edge://extensions/?id=x', 'about:config', 'file:///etc/hosts', 'mailto:a@b.c'])
    assert.equal(kind(href), 'ignore', href)
  for (const href of ['blob:tauri://localhost/1', 'data:text/plain,x', 'javascript:void 0', '', null])
    assert.equal(kind(href), 'none', String(href))
  // Dev and Windows serve the app over http: its own pages are still pages, not the web.
  assert.equal(kind('/info.html', 'http://127.0.0.1:1430/settings.html'), 'page')
  assert.equal(kind('http://tauri.localhost/info.html', 'http://tauri.localhost/settings.html'), 'page')
  assert.equal(classifyLink('info.html', SETTINGS).url, 'tauri://localhost/info.html')
})

test('only an extension page at the origin root gets the handling, never Kimochi\'s documents', () => {
  const at = (pathname) => isExtensionPage({ location: { pathname } })
  for (const page of ['/settings.html', '/popup.html', '/search.html', '/info.html', '/quick-start-guide.html'])
    assert.equal(at(page), true, page)
  for (const page of ['/app/panel.html', '/ui/overlay.html', '/spike/background.html', '/index.html', '/'])
    assert.equal(at(page), false, page)
})

/** A window with listeners, enough DOM for anchors, and a recorder for what the host is asked. */
function fakeWindow(href = SETTINGS) {
  const listeners = {}
  class EventTarget {
    dispatchEvent(event) {
      this.dispatched = (this.dispatched ?? 0) + 1
      return !event.defaultPrevented
    }
  }
  class HTMLAnchorElement extends EventTarget {
    constructor(attributes = {}, connected = true) {
      super()
      this.attributes = { ...attributes }
      this.localName = 'a'
      this.isConnected = connected
      this.clicked = 0
    }
    get href() {
      return this.attributes.href === undefined ? '' : new URL(this.attributes.href, href).href
    }
    get target() {
      return this.attributes.target ?? ''
    }
    getAttribute(name) {
      return this.attributes[name] ?? null
    }
    hasAttribute(name) {
      return name in this.attributes
    }
    click() {
      this.clicked++
    }
  }
  const opened = []
  const win = {
    location: new URL(href),
    EventTarget,
    HTMLAnchorElement,
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    open: (...args) => {
      opened.push(args)
      return { native: true }
    },
    fetch: async (url) => ({ blob: async () => ({ type: 'application/json', arrayBuffer: async () => new TextEncoder().encode(`bytes of ${url}`).buffer }) })
  }
  const fire = (type, anchor, extra = {}) => {
    const event = {
      type,
      button: type === 'auxclick' ? 1 : 0,
      defaultPrevented: false,
      composedPath: () => [{ localName: 'span' }, anchor, { localName: 'body' }],
      preventDefault() {
        this.defaultPrevented = true
      },
      ...extra
    }
    for (const fn of listeners[type] ?? []) fn(event)
    return event
  }
  return { win, fire, opened, listeners, HTMLAnchorElement }
}

test('a web link opens in the system browser, whatever its target, and the frame stays put', async () => {
  const { win, fire, HTMLAnchorElement } = fakeWindow()
  const asked = []
  installPageLinks(win, { open: (url, kind) => asked.push([url, kind]) })
  const blank = fire('click', new HTMLAnchorElement({ href: 'https://yomitan.wiki/anki/', target: '_blank' }))
  const plain = fire('click', new HTMLAnchorElement({ href: 'https://github.com/yomidevs/yomitan' }))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(blank.defaultPrevented, true)
  assert.equal(plain.defaultPrevented, true, 'a web link without a target must not load inside the settings frame')
  assert.deepEqual(asked, [
    ['https://yomitan.wiki/anki/', 'web'],
    ['https://github.com/yomidevs/yomitan', 'web']
  ])
})

test('an extension page stays in its frame unless a new tab was asked for', async () => {
  const { win, fire, HTMLAnchorElement } = fakeWindow()
  const asked = []
  installPageLinks(win, { open: (url, kind) => asked.push([url, kind]) })
  const inFrame = fire('click', new HTMLAnchorElement({ href: '/info.html' }))
  const section = fire('click', new HTMLAnchorElement({ href: '#anki' }))
  const newTab = fire('click', new HTMLAnchorElement({ href: '/search.html', target: '_blank' }))
  const modified = fire('click', new HTMLAnchorElement({ href: '/legal.html' }), { metaKey: true })
  const middle = fire('auxclick', new HTMLAnchorElement({ href: '/support.html' }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(inFrame.defaultPrevented, false)
  assert.equal(section.defaultPrevented, false)
  assert.equal(newTab.defaultPrevented, true)
  assert.equal(modified.defaultPrevented, true)
  assert.equal(middle.defaultPrevented, true)
  assert.deepEqual(asked.map(([url, kind]) => [new URL(url).pathname, kind]), [
    ['/search.html', 'page'],
    ['/legal.html', 'page'],
    ['/support.html', 'page']
  ])
})

test('what the page already handled, and browser-internal links, are not opened', async () => {
  const { win, fire, HTMLAnchorElement } = fakeWindow('tauri://localhost/popup.html')
  const asked = []
  const logged = []
  installPageLinks(win, { open: (url) => asked.push(url), log: (value) => logged.push(value) })
  // Yomitan's popup turns its own links into searches and cancels them first.
  fire('click', new HTMLAnchorElement({ href: '/search.html?query=x' }), { defaultPrevented: true })
  const shortcuts = fire('click', new HTMLAnchorElement({ href: 'chrome://extensions/shortcuts', target: '_blank' }))
  const toggle = fire('click', new HTMLAnchorElement({ tabindex: '0' }))
  const right = fire('click', new HTMLAnchorElement({ href: 'https://example.com' }), { button: 2 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(asked, [])
  assert.equal(shortcuts.defaultPrevented, true, 'an about:/chrome: page must not load into the frame')
  assert.equal(toggle.defaultPrevented, false, 'a link without href (Yomitan\'s "more" toggles) is the page\'s')
  assert.equal(right.defaultPrevented, false)
  assert.ok(logged.some((value) => value.check === 'page-link-ignored'))
})

test('window.open sends web pages to the system browser and leaves the rest to the platform', async () => {
  const { win, opened } = fakeWindow()
  const asked = []
  installPageLinks(win, { open: (url, kind) => asked.push([url, kind]) })
  assert.equal(win.open('https://example.com/x'), null)
  assert.equal(win.open('/info.html', '_blank'), null)
  assert.deepEqual(win.open('blob:tauri://localhost/1', '_blank'), { native: true })
  assert.deepEqual(win.open('/info.html', '_self'), { native: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(asked, [
    ['https://example.com/x', 'web'],
    ['tauri://localhost/info.html', 'page']
  ])
  assert.equal(opened.length, 2)
})

test('Yomitan\'s blob downloads reach the save handler, however the anchor is clicked', async () => {
  const { win, fire, HTMLAnchorElement } = fakeWindow()
  const saved = []
  installDownloads(win, { save: (file) => saved.push(file) })
  // backup-controller.js `_saveBlob`: a detached anchor sent a synthetic click.
  const detached = new HTMLAnchorElement({ href: 'blob:tauri://localhost/a', download: 'yomitan-settings.json', target: '_blank' }, false)
  assert.equal(detached.dispatchEvent({ type: 'click' }), false)
  assert.equal(detached.dispatched, undefined, 'the cancelled navigation is never dispatched')
  new HTMLAnchorElement({ href: 'blob:tauri://localhost/b', download: 'deck.txt' }, false).click()
  const inPage = fire('click', new HTMLAnchorElement({ href: 'data:text/plain,x', download: '' }))
  // Not a download: left alone.
  const plain = new HTMLAnchorElement({ href: '/info.html' }, false)
  plain.click()
  plain.dispatchEvent({ type: 'click' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(inPage.defaultPrevented, true)
  assert.equal(plain.clicked, 1)
  assert.equal(plain.dispatched, 1)
  assert.deepEqual(saved.map((file) => file.name).sort(), ['download', 'deck.txt', 'yomitan-settings.json'].sort())
  const backup = saved.find((file) => file.name === 'yomitan-settings.json')
  assert.equal(new TextDecoder().decode(backup.bytes), 'bytes of blob:tauri://localhost/a')
})

test('a file dropped outside a drop zone is refused; a drop zone keeps its drops', () => {
  const { win, listeners } = fakeWindow()
  installFileDropGuard(win)
  const event = (type, types, prevented = false) => ({
    type,
    defaultPrevented: prevented,
    dataTransfer: { types, dropEffect: 'copy' },
    preventDefault() {
      this.defaultPrevented = true
    }
  })
  const stray = event('dragover', ['Files'])
  listeners.dragover.forEach((fn) => fn(stray))
  assert.equal(stray.defaultPrevented, true)
  assert.equal(stray.dataTransfer.dropEffect, 'none')
  const zone = event('dragover', ['Files'], true)
  zone.dataTransfer.dropEffect = 'copy'
  listeners.dragover.forEach((fn) => fn(zone))
  assert.equal(zone.dataTransfer.dropEffect, 'copy', 'Yomitan\'s import zone accepted it')
  const text = event('dragover', ['text/plain'])
  listeners.dragover.forEach((fn) => fn(text))
  assert.equal(text.defaultPrevented, false, 'dragging list items is not a file drop')
  const drop = event('drop', ['Files'])
  listeners.drop.forEach((fn) => fn(drop))
  assert.equal(drop.defaultPrevented, true)
})

// ---------------------------------------------------------------- the real panel bundle

const panelShim = await yomitanShimSource('panel-shim.js', { network: 'Promise.resolve()' })

/** The panel shim as the top document of the `dictionary` window, with its relay recorded. */
async function dictionaryWindow() {
  const frame = { assigned: [], contentWindow: null }
  frame.contentWindow = { location: { assign: (url) => frame.assigned.push(url) } }
  const context = vm.createContext({ URL, console, structuredClone, Promise, setTimeout, clearTimeout, TextEncoder })
  vm.runInContext(
    `window = globalThis;
     location = {href:'tauri://localhost/app/panel.html',origin:'tauri://localhost',protocol:'tauri:',host:'localhost',pathname:'/app/panel.html'};
     navigator = {language:'en',platform:'MacIntel'};
     addEventListener = () => {}; dispatchEvent = () => {};
     fetch = async () => ({json: async () => ({})});
     XMLHttpRequest = class {};
     MessageChannel = class { constructor() { this.port1 = {}; this.port2 = {} } };
     top = window; __kimochiPanelLabel = 'dictionary'; relayed = []; reports = [];
     __TAURI__ = {
       core: {invoke: async (cmd, args) => {
         if (cmd === 'ext_relay') relayed.push(JSON.parse(JSON.stringify(args)))
         if (cmd === 'report') reports.push(args.value)
       }},
       event: {listen: async (name, f) => { relay = f }}
     };`,
    context
  )
  context.document = {
    createElement: () => ({}),
    head: { append() {} },
    querySelector: (selector) => (selector === 'iframe.dictionary-settings-frame' ? frame : null)
  }
  vm.runInContext(panelShim, context)
  await vm.runInContext('__extensionHost.ready', context)
  context.relayed.length = 0
  return { context, frame }
}

test('tabs.create, tabs.update(details) and openOptionsPage ask the overlay to open; chrome:// does not', async () => {
  const { context } = await dictionaryWindow()
  await vm.runInContext(`chrome.tabs.create({url: 'https://yomitan.wiki/'})`, context)
  // Single-argument `tabs.update`: once a silent no-op.
  await vm.runInContext(`chrome.tabs.update({url: '/welcome.html'})`, context)
  await vm.runInContext(`chrome.tabs.update(7, {url: 'info.html'})`, context)
  await vm.runInContext(`chrome.runtime.openOptionsPage()`, context)
  const ignored = await vm.runInContext(`chrome.tabs.create({url: 'chrome://extensions/shortcuts'})`, context)
  assert.equal(ignored.id, -1)
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.relayed.map(({ target, payload }) => [target, payload.kind, payload.url]))),
    [
      ['overlay', 'open', 'https://yomitan.wiki/'],
      ['overlay', 'open', 'tauri://localhost/welcome.html'],
      ['overlay', 'open', 'tauri://localhost/info.html'],
      ['overlay', 'open', 'tauri://localhost/settings.html']
    ]
  )
})

test('a page sent to the dictionary window opens in its settings frame, not in place of the panel', async () => {
  const { context, frame } = await dictionaryWindow()
  const navigate = (url, seq) =>
    vm.runInContext(
      `relay({payload: {from: 'overlay', to: 'dictionary', seq: ${seq}, payload: {kind: 'navigate', url: ${JSON.stringify(url)}}}})`,
      context
    )
  navigate('tauri://localhost/settings.html#anki', 1)
  navigate('/welcome.html', 2)
  navigate('https://example.com/', 3)
  assert.deepEqual(frame.assigned, ['tauri://localhost/settings.html#anki', 'tauri://localhost/welcome.html'])
  assert.equal(vm.runInContext('location.href', context), 'tauri://localhost/app/panel.html')
})

test('the overlay opens web pages in the system browser instead of the dictionary window', async () => {
  const source = await readFile(new URL('../ui/overlay.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function openDictionaryPage(')
  assert.notEqual(start, -1)
  const body = source.slice(start, source.indexOf('\n}\n', start))
  const shell = body.indexOf("'plugin:shell|open'")
  assert.ok(shell !== -1 && shell < body.indexOf("native.panel('dictionary'"), 'web links must not show the dictionary window')
})
