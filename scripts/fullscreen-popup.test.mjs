/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * Read along's full-screen dictionary with an engine's own pop-up (built-in Yomitan, Hachidori,
 * 10ten): the pop-up opens over the space under the scanned text instead of beside the word.
 *
 *  - Yomitan: `targetPopups` (host/popup-bridge.js) answers `Popup._getPosition` with the target
 *    and puts the frame back there after `_show` (the full-width display mode moves it).
 *  - Hachidori and 10ten: `fillCss` (host/ext/content.js) in the pop-up host's shadow root, put
 *    there by the driver's `place` and taken away once the pop-up it filled has closed.
 *
 * The seams each relies on are checked against the pinned extensions, so an update that renames
 * one fails here rather than leaving the pop-up beside the word in the app.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { setPopupTarget, targetPopups, targetPosition } from '../host/popup-bridge.js'
import { createDriver, fillCss } from '../host/ext/content.js'

const extensions = new URL('../extensions/', import.meta.url)
const BOX = { x: 120, y: 260, width: 900, height: 420 }

/** The parts of Yomitan's `Popup` the placing passes through (js/app/popup.js `_show`). */
function popupClass() {
  return class Popup {
    constructor(depth = 0, fullWidth = false) {
      this.depth = depth
      this._displayModeIsFullWidth = fullWidth
      this._frame = { style: {} }
    }

    _getPosition() {
      return { left: 10, top: 40, width: 400, height: 250, after: true, below: true }
    }

    async _show(sourceRects, writingMode) {
      let { left, top, width, height } = this._getPosition(sourceRects, writingMode, {})
      if (this._displayModeIsFullWidth) {
        left = 0
        width = 1280
        top = 0
      }
      Object.assign(this._frame.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` })
    }
  }
}

test('Yomitan: the top-level popup opens over the target, and back beside the word without one', async (t) => {
  t.after(() => setPopupTarget(null))
  const Popup = popupClass()
  targetPopups(Popup)
  targetPopups(Popup) // idempotent: wrapped once

  const popup = new Popup()
  await popup._show([], 'horizontal-tb')
  assert.deepEqual(popup._frame.style, { left: '10px', top: '40px', width: '400px', height: '250px' })

  setPopupTarget(BOX)
  assert.deepEqual(popup._getPosition([], 'horizontal-tb', {}), targetPosition(BOX))
  await popup._show([], 'horizontal-tb')
  assert.deepEqual(popup._frame.style, { left: '120px', top: '260px', width: '900px', height: '420px' })

  // The full-width display mode overrides the position it was given; the target still wins.
  const wide = new Popup(0, true)
  await wide._show([], 'horizontal-tb')
  assert.deepEqual(wide._frame.style, { left: '120px', top: '260px', width: '900px', height: '420px' })

  // A nested lookup inside the popup keeps Yomitan's placing beside its word.
  const nested = new Popup(1)
  await nested._show([], 'horizontal-tb')
  assert.deepEqual(nested._frame.style, { left: '10px', top: '40px', width: '400px', height: '250px' })

  // An empty rectangle is no target.
  setPopupTarget({ ...BOX, height: 0 })
  await popup._show([], 'horizontal-tb')
  assert.equal(popup._frame.style.left, '10px')
  setPopupTarget(null)
  await popup._show([], 'horizontal-tb')
  assert.equal(popup._frame.style.width, '400px')
})

test('Yomitan: the Popup seams the placing relies on are in the pinned build', async () => {
  const source = await readFile(new URL('yomitan/js/app/popup.js', extensions), 'utf8')
  assert.match(source, /\n {4}_getPosition\(sourceRects, writingMode, viewport\) \{/)
  assert.match(source, /\n {4}async _show\(sourceRects, writingMode\) \{/)
  // `_show` takes its rectangle from `_getPosition` and writes it to the frame's style.
  const show = source.slice(source.indexOf('async _show('), source.indexOf('_setFrameSize(width, height) {'))
  assert.match(show, /this\._getPosition\(sourceRects, writingMode, viewport\)/)
  assert.match(show, /frame\.style\.left = `\$\{left\}px`/)
  assert.match(source, /\n {4}get depth\(\) \{/)
})

test('Hachidori and 10ten: the fill stylesheet puts the top-level pop-up over the box', () => {
  const hachidori = fillCss('hachidori', BOX)
  assert.match(hachidori, /^\.gsm-hoshidicts-popup\[data-hoshidicts-depth="0"\] \{/)
  for (const rule of ['left: 120px !important', 'top: 260px !important', 'width: 900px !important', 'height: 420px !important'])
    assert.ok(hachidori.includes(rule), rule)

  const tenten = fillCss('tenten', { x: 10.123, y: 20, width: 300.5, height: 200 })
  for (const rule of [
    'left: 10.12px !important',
    'top: 20px !important',
    'width: 300.5px !important',
    'max-width: 300.5px !important',
    'min-height: 200px !important',
    'max-height: 200px !important',
    '.container .arrow { display: none !important; }'
  ])
    assert.ok(tenten.includes(rule), rule)

  assert.equal(fillCss('tenten', null), '')
  assert.equal(fillCss('hachidori', { ...BOX, width: 0 }), '')
  assert.equal(fillCss('yomitan', BOX), '')
})

test('Hachidori and 10ten: the selectors the fill relies on are in the pinned builds', async () => {
  const hachidori = await readFile(new URL('hachidori/content.js', extensions), 'utf8')
  assert.match(hachidori, /popup\.className = "gsm-hoshidicts-popup";/)
  assert.match(hachidori, /popup\.dataset\.hoshidictsDepth = String\(level\.depth\);/)
  assert.match(hachidori, /level\.popup\.style\.left = `\$\{position\.left\}px`;/)
  assert.match(hachidori, /attachShadow\(\{ mode: "open" \}\)/)
  const tenten = await readFile(new URL('tenten/10ten-ja-content.js', extensions), 'utf8')
  assert.ok(tenten.includes('.container{left:var(--tenten-left,auto);top:var(--tenten-top,auto)'))
  assert.ok(tenten.includes('.window{max-width:var(--tenten-max-width,600px)'))
  assert.ok(tenten.includes('container.attachShadow({\n          mode: "open"'))
  // 10ten empties its shadow root between pop-ups but keeps every <style> (`resetContent`).
  assert.match(tenten, /if \(child\.tagName\.toUpperCase\(\) !== "STYLE"\) child\.remove\(\);/)
})

/** A window with an engine's pop-up host whose shadow root holds `parts` while it shows. */
function fakeWindow() {
  const styles = []
  const state = { showing: false, hostCreated: false, observers: [] }
  const part = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }) }
  const shadowRoot = {
    querySelector: (selector) => (selector === 'style[data-kimochi-fill]' ? (styles[0] ?? null) : null),
    querySelectorAll: () => (state.showing ? [part] : []),
    append: (node) => {
      node.remove = () => styles.splice(styles.indexOf(node), 1)
      styles.push(node)
    }
  }
  const host = { shadowRoot }
  const win = {
    document: {
      documentElement: {},
      querySelector: () => (state.hostCreated ? host : null),
      createElement: () => {
        const attributes = new Map()
        return { textContent: '', setAttribute: (name, value) => attributes.set(name, value), attributes }
      }
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
        this.active = false
      }
      observe() {
        this.active = true
        state.observers.push(this)
      }
      disconnect() {
        this.active = false
      }
    }
  }
  /** The engine makes its host, as on its first lookup: the observers see it. */
  const createHost = () => {
    state.hostCreated = true
    for (const observer of state.observers) if (observer.active) observer.callback([])
  }
  return { win, state, styles, createHost }
}

const descriptor = (id) => ({
  id,
  popupSelector: id === 'tenten' ? '#tenten-ja-window' : 'hachidori-host',
  popupParts: '.part',
  pointerEvents: ['pointermove']
})

test("an engine's driver keeps the fill on its host, and takes it off once the pop-up has closed", async () => {
  const { win, state, styles, createHost } = fakeWindow()
  const driver = createDriver(win, { descriptor: descriptor('tenten'), context: {}, report: () => {}, backgroundSender: () => null })

  // No host yet (no lookup so far): the fill waits for one and lands the moment it is made.
  driver.place(BOX)
  assert.equal(styles.length, 0)
  createHost()
  assert.equal(styles.length, 1)
  assert.equal(styles[0].textContent, fillCss('tenten', BOX))
  assert.equal(styles[0].attributes.get('data-kimochi-fill'), '')

  // A new box replaces the rules in the same stylesheet.
  const moved = { ...BOX, y: 300 }
  driver.place(moved)
  assert.equal(styles.length, 1)
  assert.equal(styles[0].textContent, fillCss('tenten', moved))

  // Cleared while the pop-up still shows: kept until it has closed, so it does not jump.
  state.showing = true
  driver.place(null)
  assert.equal(styles.length, 1)
  state.showing = false
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(styles.length, 0)
  assert.ok(state.observers.every((observer) => !observer.active), 'stops watching the document')

  // A new box before the old clear has run keeps the new one.
  driver.place(BOX)
  state.showing = true
  driver.place(null)
  driver.place(moved)
  state.showing = false
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(styles.length, 1)
  assert.equal(styles[0].textContent, fillCss('tenten', moved))
})
