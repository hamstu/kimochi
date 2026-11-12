/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helpers. */
/**
 * Hovering a word in text set with spaces (Spanish, French, English) looks up the whole word.
 *
 * A dictionary in word mode scans back from the pointer to the word's start, and Yomitan's
 * `DOMTextScanner` stops at an element. The overlay moves glyphs onto the engine's boxes with margin
 * spans (render.js `appendRunText`), so a word moved letter by letter became several elements and
 * hovering its middle looked up only its tail ("ompleta"); and a line's last word ran into the next
 * line's first ("categoríade"). OCR answers are drawn here (overlay-cases.mjs) and scanned with the
 * vendored Yomitan scanner, as a hover does.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
import { installFakeDom, draw, line, paragraph, block, words } from './overlay-cases.mjs'

installFakeDom()
const modules = await load('render.js')
const { selectionExtension } = modules
const { fit, characterCells, wholeWords } = await load('text-layout.js')
const { DOMTextScanner } = await import('../extensions/yomitan/js/dom/dom-text-scanner.js')

/** The text nodes under a drawn element, in order, without its lookahead. */
const textNodes = (node) =>
  node.tag === 'text'
    ? [node]
    : node.className === 'ocr-lookahead'
      ? []
      : node.children.length
        ? node.children.flatMap(textNodes)
        : node.textContent
          ? [node]
          : []

/** A DOM text node, as `DOMTextScanner` reads one. */
function textNode(value, parentNode = null) {
  return {
    nodeType: 3,
    nodeName: '#text',
    nodeValue: value,
    parentNode,
    childNodes: [],
    previousSibling: null,
    nextSibling: null
  }
}

/**
 * The drawn tree as the DOM `DOMTextScanner` walks (as lookahead.test.mjs builds it); `map` gets
 * the DOM text node for each drawn text node, or for an element that holds its text directly.
 */
function toDom(fake, map, parentNode = null) {
  if (fake.tag === 'text') {
    map.set(fake, textNode(fake.textContent, parentNode))
    return map.get(fake)
  }
  const node = {
    nodeType: 1,
    nodeName: fake.tag.toUpperCase(),
    className: fake.className,
    parentNode,
    previousSibling: null,
    nextSibling: null
  }
  let children = []
  if (fake.children.length) children = fake.children.map((child) => toDom(child, map, node))
  else if (fake.textContent) {
    map.set(fake, textNode(fake.textContent, node))
    children = [map.get(fake)]
  }
  children.forEach((child, i) => {
    child.previousSibling = children[i - 1] ?? null
    child.nextSibling = children[i + 1] ?? null
  })
  node.childNodes = children
  node.firstChild = children[0] ?? null
  node.lastChild = children.at(-1) ?? null
  return node
}

/** What a word lookup reads from `offset` in `node`: back to the word's start, or `length` on. */
const scan = (node, offset, length) => new DOMTextScanner(node, offset, false, true, length < 0).seek(length).content

const LINES = [
  'Completa encargos, dona objetos al museo y envía',
  "Il a vu l'été passer sans rien dire",
  "Un bicchiere dell'acqua fresca per tutti",
  '¿Qué hora es? Ya es tarde',
  'Un cafe\u0301 noir et un the\u0301 vert'
]

for (const grouped of [false, true]) {
  const mode = grouped ? 'grouped' : 'word'

  test(`${mode} mode: a word scan from any letter finds the word's start, as in the log`, () => {
    for (const text of LINES) {
      const { host, renderer } = draw(modules, { annotations: line(words(text)) }, grouped)
      // Each run's signature (render.js `runSignature`) ends in its offsets, if the layout moved glyphs.
      const runs = JSON.parse(host.children[0].renderKey)[grouped ? 3 : 8]
      assert.ok(
        runs.some((run) => run.length > 11),
        `${text}: nothing moved, so this tests nothing`
      )
      const nodes = textNodes(host.children[0])
      assert.equal(nodes.map((n) => n.textContent).join(''), text)
      const map = new Map()
      toDom(host.children[0], map)
      // The same line as the log shows it: one text node.
      const log = textNode(text)
      let at = 0
      for (const fake of nodes) {
        for (let offset = 0; offset < fake.textContent.length; offset++) {
          const i = at + offset
          if (!/\p{L}/u.test(text[i])) continue
          assert.equal(scan(map.get(fake), offset, -32), scan(log, i, -32), `${text}: from ${text[i]}@${i}`)
        }
        at += fake.textContent.length
      }
      renderer.destroy()
    }
  })

  test(`${mode} mode: a line's last word is read whole, then the next line after a space`, () => {
    const lines = ['objetos a cambio de téseras', 'para aumentar la categoría', 'de aldea a estrella'].map(words)
    // Read a line at a time (PP-OCR: a box per line) and whole (Google Lens: one box, a run a line).
    const readings = [
      [paragraph(lines), 'categoría', 'de'],
      [block(lines), 'téseras', 'para'],
      [block(lines), 'categoría', 'de']
    ]
    for (const [annotations, word, next] of readings) {
      const { host, renderer } = draw(modules, { annotations }, grouped)
      const map = new Map()
      for (const box of host.children) toDom(box, map)
      const holder = host.children.flatMap(textNodes).find((n) => n.textContent.includes(word))
      const read = scan(map.get(holder), holder.textContent.indexOf(word), 16).replace(/\s+/gu, ' ')
      assert.match(read, new RegExp(`^${word} ${next}\\b`, 'u'))
      renderer.destroy()
    }
  })
}

test('whole words are the runs between spaces with a letter, in text without Japanese', () => {
  assert.deepEqual(wholeWords("¿Qué? l'été 42 dell'acqua"), [
    [0, 4],
    [6, 10],
    [15, 24]
  ])
  assert.deepEqual(wholeWords('cafe\u0301 noir'), [
    [0, 4],
    [6, 9]
  ])
  assert.deepEqual(wholeWords('HP 30 ok'), [
    [0, 1],
    [6, 7]
  ])
  // Japanese, full-width forms, or nothing at all: no whole words.
  for (const text of ['猫は 犬だ「HP」 ねこ', '体力 ＨＰ が', 'HP！ 回復', '']) {
    assert.deepEqual(wholeWords(text), [], text)
  }
})

test('the controller outlines a spaced word as contiguous cells that move together', () => {
  const text = 'Completa encargos, dona objetos'
  const em = (s) => [...s].length * 0.55
  let x = 0
  let at = 0
  const segments = text.split(' ').map((word, i) => {
    const segment = { text: word, at, x, y: 0, width: word.length * 17 * [0.8, 1.2, 1, 0.8][i], height: 30 }
    x += segment.width + 10
    at += word.length + 1
    return segment
  })
  const fitted = fit({ text, segments, rect: { x: 0, y: 0, width: x - 10, height: 30 } }, false, em)
  assert.ok(fitted.offsets, 'nothing moved')
  const cells = characterCells(text, [fitted], false, em)
  for (const [first, last] of wholeWords(text))
    for (let k = first; k < last; k++) {
      assert.equal(fitted.offsets[k + 1], fitted.offsets[first], `${text[k + 1]} moved apart from its word`)
      assert.ok(Math.abs(cells[k].x + cells[k].width - cells[k + 1].x) < 1e-6, `gap after ${text[k]}`)
    }
})

test("a selection over the joiner extends the box with the next line's word", () => {
  const spanish = [
    { text: 'alcanza la', next: 1 },
    { text: 'de acuerdo', next: -1 }
  ]
  assert.deepEqual(selectionExtension('alcanza la de', 0, spanish), { extension: ' de', consumed: [] })
  assert.deepEqual(selectionExtension('alcanza la de acuerdo', 0, spanish), { extension: ' de acuerdo', consumed: [1] })
  const japanese = [
    { text: '食べ', next: 1 },
    { text: 'ました', next: -1 }
  ]
  assert.deepEqual(selectionExtension('食べました', 0, japanese), { extension: 'ました', consumed: [1] })
})
