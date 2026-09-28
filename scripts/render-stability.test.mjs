import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
let created = 0
function element(tag = 'div') {
  created++
  const e = {
    tag,
    children: [],
    style: {
      setProperty(k, v) {
        this[k] = v
      }
    },
    dataset: {},
    className: '',
    textContent: '',
    listeners: {},
    classList: { add() {} },
    addEventListener(k, f) {
      this.listeners[k] = f
    },
    append(...nodes) {
      for (const n of nodes) {
        n.remove?.()
        this.children.push(n)
        n.parent = this
      }
    },
    insertBefore(n, next) {
      n.remove?.()
      const i = next ? this.children.indexOf(next) : this.children.length
      this.children.splice(i, 0, n)
      n.parent = this
    },
    remove() {
      if (this.parent) {
        this.parent.children.splice(this.parent.children.indexOf(this), 1)
        this.parent = null
      }
    },
    replaceChildren() {
      for (const n of [...this.children]) n.remove()
    },
    querySelector(selector) {
      for (const n of this.children) {
        if (n.className === selector.slice(1)) return n
        const found = n.querySelector?.(selector)
        if (found) return found
      }
      return null
    }
  }
  return e
}
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  getSelection() {
    return null
  }
}
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  createElement: element,
  createDocumentFragment: () => element('fragment'),
  createTextNode: (text) => ({ ...element('text'), textContent: text })
}
globalThis.requestAnimationFrame = () => 1
const { TextOverlayRenderer } = await load('render.js')
const word = (text, x) => ({
  description: text,
  boundingPoly: {
    vertices: [
      { x, y: 0 },
      { x: x + 30, y: 0 },
      { x: x + 30, y: 20 },
      { x, y: 20 }
    ]
  }
})
const info = {
  full_width: 300,
  full_height: 100,
  crop_pixels: [0, 0, 300, 100],
  source_bounds: { x: 0, y: 0, width: 300, height: 100 }
}
const view = (words, extras = {}) => ({
  annotations: [word('aggregate', 0), ...words],
  info,
  origin: { x: 0, y: 0, width: 300, height: 100 },
  grouping: { enabled: false, filterSmallText: false },
  opacity: 60,
  scanning: false,
  ...extras
})

test('unchanged text and scanning toggles do not replace nodes or allocate new words', () => {
  const host = element(),
    r = new TextOverlayRenderer(host)
  r.render(view([word('猫', 0), word('犬', 60)]))
  const nodes = [...host.children],
    before = created
  r.render(
    view([word('猫', 0), word('犬', 60)], { scanning: true, info: { ...info, total_ms: 999 } })
  )
  assert.deepEqual(host.children, nodes)
  assert.equal(created, before)
  assert.ok(host.children.every((n) => n.className === 'ocr-word'))
})
test('changing a HUD word preserves the dialogue node, hover and lookup state', () => {
  const host = element(),
    r = new TextOverlayRenderer(host)
  r.render(view([word('猫', 0), word('HP12', 60)]))
  const stable = host.children[0],
    oldHud = host.children[1],
    text = stable.querySelector('.ocr-word-current')
  r.lastLookupIndex = 0
  r.selectionIndices.add(0)
  const change = r.render(view([word('猫', 0), word('HP11', 60)]))
  assert.equal(host.children[0], stable)
  assert.equal(stable.querySelector('.ocr-word-current'), text)
  assert.notEqual(host.children[1], oldHud)
  assert.equal(r.lastLookupIndex, 0)
  assert.ok(r.selectionIndices.has(0))
  assert.deepEqual(change, { created: 1, retained: 1, removed: 1 })
})
test('removing a preceding word preserves the remaining node and reindexes its interactions', () => {
  const host = element(),
    r = new TextOverlayRenderer(host)
  r.render(view([word('HP12', 0), word('猫', 60)]))
  const stable = host.children[1]
  r.lastLookupIndex = 1
  r.selectionIndices.add(1)
  r.render(view([word('猫', 60)]))
  assert.equal(host.children[0], stable)
  assert.equal(stable.ocrIndex, 0)
  assert.equal(r.lastLookupIndex, 0)
  assert.ok(r.selectionIndices.has(0))
  r.clear()
  assert.equal(host.children.length, 0)
  r.render(view([word('猫', 60)]))
  assert.notEqual(host.children[0], stable)
})
test('moving the selected source updates actual word placement rather than caching stale coordinates', () => {
  const host = element(),
    r = new TextOverlayRenderer(host)
  r.render(view([word('猫', 0)]))
  const old = host.children[0]
  r.render(view([word('猫', 0)], { bounds: { x: 100, y: 0, width: 300, height: 100 } }))
  assert.notEqual(host.children[0], old)
  assert.equal(host.children[0].style.left, '100px')
})
test('grouped text also survives a scan status toggle', () => {
  const host = element(),
    r = new TextOverlayRenderer(host)
  const v = view([word('猫', 0)], {
    grouping: { enabled: true, filterSmallText: false, proximityThreshold: 20 }
  })
  r.render(v)
  const stable = host.children[0]
  r.render({ ...v, scanning: true })
  assert.equal(host.children[0], stable)
  assert.equal(stable.className, 'ocr-group')
})

test('small OCR box jitter preserves text nodes but cannot accumulate into a drifting anchor', () => {
  const host = element(),
    r = new TextOverlayRenderer(host)
  r.render(view([word('猫', 10)]))
  const stable = host.children[0]
  r.render(view([word('猫', 11)]))
  assert.equal(host.children[0], stable)
  r.render(view([word('猫', 12)]))
  assert.equal(host.children[0], stable)
  assert.equal(r.words[0].box.x, 10, 'proximity and hit geometry retain the same anchor')
  r.render(view([word('猫', 13)]))
  assert.notEqual(host.children[0], stable)
})
test('even a one-point actual source movement bypasses OCR jitter tolerance', () => {
  const host = element(),
    r = new TextOverlayRenderer(host)
  r.render(view([word('猫', 10)]))
  const stable = host.children[0]
  r.render(view([word('猫', 10)], { bounds: { x: 1, y: 0, width: 300, height: 100 } }))
  assert.notEqual(host.children[0], stable)
  assert.equal(host.children[0].style.left, '11px')
})
