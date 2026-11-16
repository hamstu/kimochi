// Hachidori's pop-up root, kept open in app documents (host/ext/content.js `installOpenPopupRoot`).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { installOpenPopupRoot } from '../host/ext/content.js'
import { extensionsDir, root } from './sync-extension.mjs'

// The real descriptors, bundled as the host is (engines.js inlines the pinned manifests).
const bundled = await build({
  entryPoints: [path.join(root, 'host', 'ext', 'engines.js')],
  bundle: true,
  write: false,
  format: 'esm',
  logLevel: 'silent'
})
const { ENGINES } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

/** A window with just enough of `Element` for attachShadow: each call records the init it got. */
function fakeWindow() {
  const calls = []
  class Element {
    constructor(localName) {
      this.localName = localName
      this.shadowRoot = null
    }
    matches(selector) {
      return selector === this.localName
    }
  }
  Object.defineProperty(Element.prototype, 'attachShadow', {
    configurable: true,
    writable: true,
    enumerable: true,
    value: function attachShadow(init) {
      calls.push({ element: this, init })
      const root = { mode: init.mode, host: this }
      if (init.mode === 'open') this.shadowRoot = root
      return root
    }
  })
  return { win: { Element }, Element, calls }
}

test("Hachidori's descriptor asks for an open pop-up root; 10ten's does not", () => {
  assert.equal(ENGINES.hachidori.openPopupRoot, true)
  assert.equal(ENGINES.hachidori.popupSelector, 'hachidori-host')
  assert.ok(!ENGINES.tenten.openPopupRoot)
})

test('a closed root on the pop-up host comes back open and readable through host.shadowRoot', () => {
  const { win, Element, calls } = fakeWindow()
  assert.equal(installOpenPopupRoot(win, ENGINES.hachidori), true)
  const host = new Element('hachidori-host')
  const root = host.attachShadow({ mode: 'closed', delegatesFocus: true })
  assert.equal(root.mode, 'open')
  assert.equal(host.shadowRoot, root)
  // Every other option is passed through unchanged.
  assert.deepEqual(calls[0].init, { mode: 'open', delegatesFocus: true })
})

test('every other element, and an open request, is passed through as it is', () => {
  const { win, Element, calls } = fakeWindow()
  installOpenPopupRoot(win, ENGINES.hachidori)
  const other = new Element('my-widget')
  const init = { mode: 'closed' }
  assert.equal(other.attachShadow(init).mode, 'closed')
  assert.equal(other.shadowRoot, null)
  assert.equal(calls[0].init, init, 'the same object, untouched')
  const open = { mode: 'open' }
  new Element('hachidori-host').attachShadow(open)
  assert.equal(calls[1].init, open)
})

test('installed once per window, and not at all for an engine that does not ask', () => {
  const { win, Element } = fakeWindow()
  const before = Element.prototype.attachShadow
  assert.equal(installOpenPopupRoot(win, ENGINES.tenten), false)
  assert.equal(Element.prototype.attachShadow, before)
  assert.equal(installOpenPopupRoot(win, ENGINES.hachidori), true)
  const wrapped = Element.prototype.attachShadow
  assert.notEqual(wrapped, before)
  assert.equal(installOpenPopupRoot(win, ENGINES.hachidori), false)
  assert.equal(Element.prototype.attachShadow, wrapped)
  assert.equal(Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow').enumerable, true)
  // A window without Element (a worker) is left alone.
  assert.equal(installOpenPopupRoot({}, ENGINES.hachidori), false)
})

test('an element whose matches() throws is passed through', () => {
  const { win, Element } = fakeWindow()
  installOpenPopupRoot(win, ENGINES.hachidori)
  const odd = new Element('x')
  odd.matches = () => {
    throw Error('nope')
  }
  assert.equal(odd.attachShadow({ mode: 'closed' }).mode, 'closed')
})

// What the wrapper counters, in the pinned release: the pop-up's host element is created with
// HOST_TAG and its root attached closed. If a new pin stops doing that (or renames the host), this
// says so, and `openPopupRoot` can be dropped or `popupSelector` moved with it.
test("the pinned Hachidori attaches its pop-up's root closed on the host this descriptor names", async () => {
  const source = await readFile(path.join(extensionsDir, 'hachidori', 'content.js'), 'utf8')
  assert.match(source, /const HOST_TAG = "hachidori-host";/)
  assert.match(source, /host = document\.createElement\(HOST_TAG\);/)
  assert.match(source, /shadow = attachPopupRoot\(\);/)
  assert.match(source, /return host\.attachShadow\(\{ mode: "closed" \}\);/)
})
