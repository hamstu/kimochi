/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * Extension pages in a Kimochi window (host/ext/page.js): where their links, `window.open` calls
 * and downloads go. A browser tab would open a new tab or download a file; a webview frame does
 * neither, so the host sends web links to the system browser, the extension's own pages to the
 * dictionary window and downloads to a save dialog.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { installPage, linkAction, windowOpenTarget } from '../host/ext/page.js'

const LOOPBACK = 'http://127.0.0.1:41234'
const SCHEME = 'tenten://localhost'

/** An `<a>` as the page script builds it: attributes, the resolved `href`, connected or not. */
function anchor(attrs, { base = `${LOOPBACK}/settings.html`, connected = true } = {}) {
  const element = {
    localName: 'a',
    isConnected: connected,
    listeners: [],
    getAttribute: (name) => (name in attrs ? String(attrs[name]) : null),
    hasAttribute: (name) => name in attrs,
    get href() {
      try {
        return new URL(attrs.href, base).href
      } catch {
        return attrs.href
      }
    },
    get target() {
      return attrs.target ?? ''
    }
  }
  return element
}

test('web links leave for the system browser, whatever their target', () => {
  for (const target of [undefined, '_blank', '_self']) {
    const attrs = { href: 'https://github.com/bee-san/hachidori/blob/main/docs/privacy.md' }
    if (target) attrs.target = target
    assert.deepEqual(linkAction(anchor(attrs), { origin: LOOPBACK }), { action: 'open', url: attrs.href })
  }
  assert.deepEqual(linkAction(anchor({ href: 'http://example.com/', target: '_blank' }), { origin: SCHEME }), { action: 'open', url: 'http://example.com/' })
})

test("the extension's own pages: same frame as in a tab, a new tab through the hub", () => {
  // Hachidori is on its loopback origin (http): its own pages are not "the web".
  assert.equal(linkAction(anchor({ href: 'settings.html#anki' }), { origin: LOOPBACK }), null)
  assert.equal(linkAction(anchor({ href: '#dictionaries' }), { origin: LOOPBACK }), null)
  assert.deepEqual(linkAction(anchor({ href: 'startup.html', target: '_blank' }), { origin: LOOPBACK }), { action: 'open', url: `${LOOPBACK}/startup.html` })
  assert.deepEqual(linkAction(anchor({ href: 'settings.html' }), { origin: LOOPBACK, newTab: true }), { action: 'open', url: `${LOOPBACK}/settings.html` })
  // 10ten on its custom scheme, whose URL origin is "null".
  assert.equal(linkAction(anchor({ href: 'options.html' }, { base: `${SCHEME}/options.html` }), { origin: SCHEME }), null)
  assert.deepEqual(
    linkAction(anchor({ href: 'options.html', target: '_blank' }, { base: `${SCHEME}/options.html` }), { origin: SCHEME }),
    { action: 'open', url: `${SCHEME}/options.html` }
  )
})

test('downloads of blob and data URLs are saved; browser-internal links are refused', () => {
  assert.deepEqual(linkAction(anchor({ href: 'blob:http://127.0.0.1:41234/5f0c', download: 'hachidori-backup-2026-10-23.zip' }), { origin: LOOPBACK }), {
    action: 'download',
    url: 'blob:http://127.0.0.1:41234/5f0c',
    name: 'hachidori-backup-2026-10-23.zip'
  })
  assert.equal(linkAction(anchor({ href: 'data:text/plain,hi', download: '' }), { origin: LOOPBACK }).name, 'download')
  assert.deepEqual(linkAction(anchor({ href: 'chrome://extensions/shortcuts', target: '_blank' }), { origin: LOOPBACK }), {
    action: 'refuse',
    url: 'chrome://extensions/shortcuts'
  })
  assert.equal(linkAction(anchor({ href: 'javascript:void 0' }), { origin: LOOPBACK }), null)
  assert.equal(linkAction(anchor({}), { origin: LOOPBACK }), null)
})

test('window.open: web and extension URLs go to the hub, anything else to the platform', () => {
  const base = `${LOOPBACK}/settings.html`
  assert.equal(windowOpenTarget('https://ankiweb.net/shared/info/2055492159', { base, origin: LOOPBACK }), 'https://ankiweb.net/shared/info/2055492159')
  assert.equal(windowOpenTarget('startup.html', { base, origin: LOOPBACK }), `${LOOPBACK}/startup.html`)
  assert.equal(windowOpenTarget('', { base, origin: LOOPBACK }), null)
  assert.equal(windowOpenTarget(undefined, { base, origin: LOOPBACK }), null)
  assert.equal(windowOpenTarget('about:blank', { base, origin: LOOPBACK }), null)
})

/** A frame's window: events, `open`, `fetch` over a table of URLs, and HTMLAnchorElement. */
function page(files = {}) {
  const events = new EventTarget()
  const opened = []
  const natives = { clicks: 0, opens: 0 }
  class HTMLAnchorElement {
    click() {
      natives.clicks += 1
    }
  }
  const win = {
    location: { href: `${LOOPBACK}/settings.html` },
    document: { baseURI: `${LOOPBACK}/settings.html` },
    addEventListener: (...args) => events.addEventListener(...args),
    dispatchEvent: (event) => events.dispatchEvent(event),
    open: () => {
      natives.opens += 1
      return { closed: false }
    },
    fetch: async (url) => (url in files ? new Response(files[url]) : new Response('missing', { status: 404 })),
    MouseEvent: class extends Event {},
    HTMLAnchorElement
  }
  const reports = []
  const saved = []
  installPage(win, {
    origin: LOOPBACK,
    open: async (url) => opened.push(url),
    save: async (name, bytes) => {
      saved.push({ name, text: new TextDecoder().decode(bytes) })
      return { saved: true }
    },
    report: (value) => reports.push(value)
  })
  /** A click on `target` as the window sees it once the page's own listeners have run. */
  const click = (target, init = {}) => {
    const event = new Event(init.type ?? 'click', { cancelable: true })
    Object.assign(event, { button: init.button ?? 0, metaKey: Boolean(init.metaKey), ctrlKey: false, shiftKey: false })
    event.composedPath = () => [target, { localName: 'body' }]
    if (init.handledByPage) event.preventDefault()
    win.dispatchEvent(event)
    return event
  }
  return { win, opened, saved, reports, natives, click, HTMLAnchorElement }
}

test('a click on a web link opens it in the browser instead of the frame', async () => {
  const { opened, click } = page()
  const event = click(anchor({ href: 'https://github.com/bee-san/hachidori-themes', target: '_blank' }))
  assert.equal(event.defaultPrevented, true)
  await Promise.resolve()
  assert.deepEqual(opened, ['https://github.com/bee-san/hachidori-themes'])
})

test("a link the page handled itself is left alone, and so is the page's own navigation", async () => {
  const { opened, click } = page()
  click(anchor({ href: 'chrome://extensions/shortcuts' }), { handledByPage: true })
  const inPage = click(anchor({ href: 'settings.html#anki' }))
  assert.equal(inPage.defaultPrevented, false)
  await Promise.resolve()
  assert.deepEqual(opened, [])
})

test("Hachidori's detached-anchor download is read and saved, not lost", async () => {
  const blob = 'blob:http://127.0.0.1:41234/backup'
  const { win, saved, reports, natives, HTMLAnchorElement } = page({ [blob]: 'zip bytes' })
  // blob-download.js: createElement('a'), href, download, click(); never appended.
  const element = Object.assign(Object.create(HTMLAnchorElement.prototype), anchor({ href: blob, download: 'hachidori-backup.zip' }, { connected: false }))
  element.dispatchEvent = () => true
  win.HTMLAnchorElement.prototype.click.call(element)
  for (let i = 0; i < 20 && saved.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(saved, [{ name: 'hachidori-backup.zip', text: 'zip bytes' }])
  assert.equal(natives.clicks, 0)
  assert.ok(reports.some((r) => r.check === 'ext-host-download' && r.saved === true))
  // A detached anchor that is nothing of ours keeps the platform's click.
  const plain = Object.assign(Object.create(HTMLAnchorElement.prototype), anchor({ href: 'settings.html' }, { connected: false }))
  win.HTMLAnchorElement.prototype.click.call(plain)
  assert.equal(natives.clicks, 1)
})

test('window.open of a web page goes to the browser and returns null; about:blank stays native', async () => {
  const { win, opened, natives } = page()
  assert.equal(win.open('https://apps.ankiweb.net/', '_blank', 'noopener'), null)
  assert.ok(win.open('about:blank'))
  await Promise.resolve()
  assert.deepEqual(opened, ['https://apps.ankiweb.net/'])
  assert.equal(natives.opens, 1)
})
