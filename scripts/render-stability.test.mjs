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
const { normalizeOcrResult } = await load('ocr-result.ts')
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

test('OneOCR line renders one contiguous lookup target and font size in both overlay modes', () => {
  const result = normalizeOcrResult({
    groups: [{ id: 'oneocr-line-0', text: '日本語を勉強しています。', bbox: [10, 10, 280, 44], orientation: 'horizontal', linePolygons: [[[10, 10], [280, 10], [280, 44], [10, 44]]] }],
    textAnnotations: [word('日', 10), word('本', 65), word('語', 95)]
  }, 'oneocr')
  for (const enabled of [false, true]) {
    const host = element()
    const renderer = new TextOverlayRenderer(host)
    renderer.render(view([], { annotations: result.textAnnotations, grouping: { enabled, filterSmallText: false } }))
    assert.equal(host.children.length, 1)
    const texts = []
    const sizes = new Set()
    const visit = (node, inheritedSize) => {
      const size = node.style?.fontSize || inheritedSize
      if (node.textContent && node.className !== 'ocr-lookahead') {
        texts.push(node.textContent)
        sizes.add(size)
      }
      for (const child of node.children ?? []) visit(child, size)
    }
    visit(host.children[0])
    assert.ok(texts.includes('日本語を勉強しています。'))
    assert.equal(sizes.size, 1, 'a line must not size its characters independently')
    renderer.destroy()
  }
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

test('vertical words retain direction through geometry mapping and light like any other', () => {
  const host=element(), renderer=new TextOverlayRenderer(host)
  renderer.render(view([{...word('縦書き',20),isVertical:true,orientation:'vertical',groupId:'v'}]))
  assert.match(host.children[0].className,/ocr-vertical/)
  renderer.setPointer(25,10)
  renderer.updateProximity()
  // Hovered: the card (`data-lit`, overlay-text.css), and nothing inline that moves the text.
  assert.equal(host.children[0].dataset.lit,'')
  assert.equal(host.children[0].style.borderBottom,undefined)
  assert.equal(host.children[0].style.borderRight,undefined)
  renderer.setPointer(500,500)
  renderer.updateProximity()
  assert.equal(host.children[0].dataset.lit,undefined)
  renderer.destroy()
})

test('grouped overlay never merges separately identified bubbles or extends lookup across them', () => {
  const host=element(), renderer=new TextOverlayRenderer(host)
  renderer.render(view([{...word('泡一',10),groupId:'a',granularity:'block',bubble:true,isVertical:true},{...word('泡二',42),groupId:'b',granularity:'block',bubble:true,isVertical:true}],{grouping:{enabled:true,filterSmallText:true,proximityThreshold:1000}}))
  assert.equal(host.children.length,2)
  assert.match(host.children[0].className,/ocr-vertical/)
  assert.equal(host.children[0].querySelector('.ocr-lookahead').textContent,'')
  renderer.destroy()
})

test('grouped overlay merges nearby blocks that are not bubbles (Live Text lines, Google Lens paragraphs)', () => {
  const host=element(), renderer=new TextOverlayRenderer(host)
  renderer.render(view([{...word('一行目',10),groupId:'livetext-line-0',granularity:'block'},{...word('二行目',42),groupId:'livetext-line-1',granularity:'block'}],{grouping:{enabled:true,filterSmallText:true,proximityThreshold:1000}}))
  assert.equal(host.children.length,1)
  renderer.destroy()
})

test('a grouped region rests as a highlight and lights as its card only when hovered, as a word box does', () => {
  globalThis.cancelAnimationFrame ??= () => {}
  const host = element(),
    renderer = new TextOverlayRenderer(host)
  renderer.render(
    view([word('一行目', 10), word('二行目', 42)], {
      grouping: { enabled: true, filterSmallText: false, proximityThreshold: 1000 }
    })
  )
  assert.equal(host.children.length, 1)
  const [region] = renderer.regions
  assert.equal(region.element, host.children[0])
  renderer.setPointer(-5000, -5000)
  renderer.flushPointer()
  assert.equal('lit' in region.element.dataset, false)
  renderer.setPointer(region.centerX, region.centerY)
  renderer.flushPointer()
  assert.equal(region.element.dataset.lit, '')
  renderer.setPointer(region.box.x + region.box.width + 400, region.centerY)
  renderer.flushPointer()
  assert.equal('lit' in region.element.dataset, false)
  renderer.destroy()
})

test('a word box carries what it sits on, for Blend cards to fill with', () => {
  const host = element(),
    renderer = new TextOverlayRenderer(host)
  const surface = { top: '#1a2343', bottom: '#20223a', ink: 'light' }
  renderer.render(view([{ ...word('猫', 10), surface }, word('犬', 60)]))
  const [cat, dog] = host.children
  assert.equal(cat.dataset.surface, 'light')
  assert.equal(cat.style['--ocr-surface-top'], '#1a2343')
  assert.equal(cat.style['--ocr-surface-bottom'], '#20223a')
  assert.equal('surface' in dog.dataset, false)
  renderer.destroy()
})

test("a grouped region combines its boxes' readings for Blend: top from the top box, bottom from the bottom one", () => {
  const host = element(),
    renderer = new TextOverlayRenderer(host)
  const line = (text, y, surface) => ({
    description: text,
    surface,
    boundingPoly: { vertices: [{ x: 10, y }, { x: 200, y }, { x: 200, y: y + 20 }, { x: 10, y: y + 20 }] }
  })
  renderer.render(
    view(
      [
        line('一行目', 0, { top: '#101830', bottom: '#141c34', ink: 'light' }),
        line('二行目', 26, { top: '#141c34', bottom: '#182038', ink: 'light' }),
        line('三行目', 52, { top: '#182038', bottom: '#1c243c', ink: 'dark' })
      ],
      { grouping: { enabled: true, filterSmallText: false, proximityThreshold: 1000 } }
    )
  )
  assert.equal(host.children.length, 1)
  const [region] = host.children
  assert.equal(region.dataset.surface, 'light')
  assert.equal(region.style['--ocr-surface-top'], '#101830')
  assert.equal(region.style['--ocr-surface-bottom'], '#1c243c')
  renderer.destroy()
})
