/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helpers. */
/**
 * OCR answers drawn by the overlay's renderer, for overlay-word-scan.test.mjs (text set with
 * spaces) and overlay-japanese.test.mjs (Japanese).
 *
 * `installFakeDom` is the renderer tests' fake DOM (render-stability.test.mjs), with a canvas that
 * measures in the overlay font's recorded metrics (glyphs.json, as overlay-alignment does), so the
 * layout takes the path it takes in the overlay, and a style lookup for Yomitan's `DOMTextScanner`.
 * `line`, `paragraph` and `block` build OCR answers the way engines give them; `draw` renders them.
 * `japaneseCases` is every Japanese answer in the alignment corpus (every engine) and hand-made lines
 * mixing Japanese with English and punctuation.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ALIGNMENT = fileURLToPath(new URL('./fixtures/overlay-alignment/', import.meta.url))
const recorded = JSON.parse(readFileSync(path.join(ALIGNMENT, 'glyphs.json'), 'utf8'))
// Half-width: Basic Latin to Latin Extended-B, and half-width katakana and marks (as render.js `measureFor`).
const HALF = /[\u0020-\u024f\uff61-\uff9f]/u
const glyph = (c) => recorded.glyphs[c] ?? (HALF.test(c) ? [0.56, 0.04, 0.52, 0.7, 0] : [1, 0.06, 0.94, 0.84, 0.08])

/** `measureText` at 100 px, in the recorded metrics. */
function measureText(text) {
  let at = 0
  // The first glyph's own extent, then the union: a mark's ink can lie wholly above the baseline.
  let ink = null
  for (const c of text) {
    const [advance, start, end, ascent, descent] = glyph(c)
    ink = {
      start: Math.min(ink?.start ?? Infinity, at + start),
      end: Math.max(ink?.end ?? -Infinity, at + end),
      ascent: Math.max(ink?.ascent ?? -Infinity, ascent),
      descent: Math.max(ink?.descent ?? -Infinity, descent)
    }
    at += advance
  }
  ink ??= { start: 0, end: 0, ascent: 0, descent: 0 }
  return {
    width: at * 100,
    actualBoundingBoxLeft: -ink.start * 100,
    actualBoundingBoxRight: ink.end * 100,
    actualBoundingBoxAscent: ink.ascent * 100,
    actualBoundingBoxDescent: ink.descent * 100,
    fontBoundingBoxAscent: recorded.font.fontAscent * 100,
    fontBoundingBoxDescent: recorded.font.fontDescent * 100
  }
}

function element(tag = 'div') {
  return {
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
    classList: { add() {}, contains: () => false },
    addEventListener() {},
    getContext: tag === 'canvas' ? () => ({ measureText }) : undefined,
    append(...nodes) {
      for (const n of nodes) {
        n.remove?.()
        this.children.push(n)
        n.parent = this
      }
    },
    insertBefore(n, next) {
      n.remove?.()
      this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, n)
      n.parent = this
    },
    remove() {
      this.parent?.children.splice(this.parent.children.indexOf(this), 1)
      this.parent = null
    },
    replaceChildren() {
      for (const n of [...this.children]) n.remove()
    },
    querySelector(selector) {
      for (const n of this.children) {
        const found = n.className === selector.slice(1) ? n : n.querySelector?.(selector)
        if (found) return found
      }
      return null
    }
  }
}

/** Install the fake DOM. Call before loading render.js. */
export function installFakeDom() {
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 }
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    getSelection: () => null,
    // The drawn text as overlay-text.css has it: visible, inline and in flow, so the only boundaries
    // a scanner meets are the elements themselves.
    getComputedStyle: () => ({
      display: 'inline',
      position: 'static',
      visibility: 'visible',
      opacity: '1',
      fontSize: '30px',
      color: 'rgb(0, 0, 0)',
      userSelect: 'text',
      webkitUserSelect: 'text',
      whiteSpace: 'normal'
    })
  }
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    createElement: element,
    createDocumentFragment: () => element('fragment'),
    createTextNode: (text) => ({ ...element('text'), textContent: text })
  }
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
}

// --- OCR answers -------------------------------------------------------------------------------

/**
 * A line's boxes as a game sets them, a box per character: full-width 30 px, half-width 16, a
 * bracket or pause in half a cell 15 where `half` says so, every fourth glyph a little off its
 * pitch, so the layout both squeezes marks and moves glyphs.
 */
export function characters(text, half = false) {
  return [...text].map((c, i) => {
    const cell = HALF.test(c) ? 16 : half && /[「」『』（）、。]/u.test(c) ? 15 : 30
    return [c, cell + [0, -3, 0, 4][i % 4]]
  })
}

/**
 * A line's boxes a word at a time (Cloud Vision, Google Lens), unevenly wide, so the layout moves
 * its words; the spaces between them, 12-20 px, are not boxed (`false`).
 */
export function words(text) {
  return text.split(' ').flatMap((word, i) => {
    const box = [word, [...word].length * 17 * [0.8, 1.2, 1][i % 3]]
    return i ? [[' ', 12 + (i % 3) * 4, false], box] : [box]
  })
}

const LEFT = 40
const ROW = 44
const vertices = (left, top, right, bottom) => [
  { x: left, y: top },
  { x: right, y: top },
  { x: right, y: bottom },
  { x: left, y: bottom }
]

/** One line's segments and outline at `row`, from its boxes `[text, width, boxed = true]`. */
function placed(cells, row) {
  const y = 40 + row * ROW
  let x = LEFT
  const segments = []
  for (const [text, width, boxed = true] of cells) {
    if (boxed) segments.push({ text, bbox: [x, y, x + width, y + 30] })
    x += width
  }
  return {
    text: cells.map(([text]) => text).join(''),
    segments,
    polygon: [
      [LEFT, y],
      [x, y],
      [x, y + 30],
      [LEFT, y + 30]
    ],
    right: x
  }
}

/** An answer for one box of `lines` (each a line's boxes), read whole, in group `id`. */
function answer(lines, id, row = 0) {
  const all = lines.map((cells, i) => placed(cells, row + i))
  const right = Math.max(...all.map((l) => l.right))
  return {
    description: all.map((l) => l.text).join('\n'),
    granularity: 'block',
    orientation: 'horizontal',
    groupId: id,
    boundingPoly: { vertices: vertices(LEFT, 40 + row * ROW, right, 40 + (row + lines.length - 1) * ROW + 30) },
    linePolygons: all.map((l) => l.polygon),
    lineSegments: all.map((l) => l.segments),
    ...(lines.length > 1 ? { lineTexts: all.map((l) => l.text) } : {})
  }
}

/** A line read by itself (OneOCR, Live Text). */
export const line = (cells) => [answer([cells], 'line')]
/** A paragraph read a line at a time (PP-OCR, OneOCR): a box per line, one group. */
export const paragraph = (lines) => lines.map((cells, row) => answer([cells], 'paragraph', row))
/** A paragraph read whole (Google Lens): one box, its lines inside it. */
export const block = (lines) => [answer(lines, 'block')]

const SCREEN = {
  full_width: 1200,
  full_height: 500,
  crop_pixels: [0, 0, 1200, 500],
  source_bounds: { x: 0, y: 0, width: 1200, height: 500 }
}

/**
 * Draw `annotations` as the overlay does, in word mode or grouped mode, into a fresh element.
 * `modules` are render.js's `TextOverlayRenderer` and, for an engine's answer, ocr-result.ts's
 * `withInkMargins`. `language` is the language being read (a code from languages.ts; absent:
 * Japanese). Returns the element and the renderer; `destroy` it when done.
 */
export function draw(
  modules,
  { annotations, engine, info = SCREEN, bounds = SCREEN.source_bounds, language },
  grouped = false
) {
  const host = globalThis.document.createElement('div')
  const renderer = new modules.TextOverlayRenderer(host)
  // As engines give them: the whole text first (`aggregate`), which the renderer leaves out.
  const all = engine
    ? modules.withInkMargins(annotations, engine)
    : [{ description: annotations.map((a) => a.description).join('\n'), granularity: 'aggregate' }, ...annotations]
  renderer.render({
    annotations: all,
    info,
    origin: bounds,
    bounds,
    grouping: { enabled: grouped, filterSmallText: false, proximityThreshold: 20, language },
    opacity: 60,
    scanning: false
  })
  return { host, renderer }
}

// --- Japanese ----------------------------------------------------------------------------------

/** Japanese mixed with English, digits and punctuation, half- and full-width. */
const MIXED = [
  'これは Apple です。',
  '「OK！」と言った',
  'HPが 12 かいふくした。',
  'Lv.5のスライムがあらわれた!',
  'ＨＰ／ＭＰが全回復！',
  'RPG『クロノ・トリガー』(1995)',
  'えっ…？　本当に!?',
  'Windows 11 で動く',
  '【重要】Steamで遊べます。',
  "'I'm fine' と彼は言った",
  'ゲーム・オーバー～',
  '攻撃力+3、防御力-1'
]

/** Paragraphs whose lines meet at Latin, digits or punctuation, as Japanese wraps them. */
const PARAGRAPHS = [
  ['最新のRPG', 'Gameです。'],
  ['ＨＰが１２', '３回復'],
  ['Lv.', '5のスライム'],
  ['HPが12', 'かいふくした'],
  ['HPが回復', 'した。'],
  ['「よし、', "Let's go!」"],
  ['レベル12', '→13にアップ'],
  ['食べ', 'ました。']
]

/** Every Japanese case: the alignment corpus's answers, then the hand-made lines. */
export function japaneseCases() {
  const corpus = readdirSync(ALIGNMENT)
    .map((file) => file.match(/^([\w-]+)\.([\w-]+)\.json$/))
    .filter((match) => match && match[2] !== 'truth')
    .map(([file, sample, engine]) => {
      const read = (name) => JSON.parse(readFileSync(path.join(ALIGNMENT, name), 'utf8'))
      const ocr = read(file)
      const { width, height, scale = 1 } = read(`${sample}.truth.json`)
      const bounds = { x: 0, y: 0, width: width / scale, height: height / scale }
      const info = { full_width: width, full_height: height, crop_pixels: [0, 0, width, height], source_bounds: bounds }
      return { name: `${sample}.${engine}`, engine: ocr.engine, annotations: ocr.textAnnotations, info, bounds }
    })
  return [
    ...corpus,
    ...MIXED.flatMap((text) => [
      { name: `line: ${text}`, annotations: line(characters(text)) },
      { name: `line, half-width marks: ${text}`, annotations: line(characters(text, true)) }
    ]),
    ...PARAGRAPHS.flatMap((texts) => [
      { name: `lines: ${texts.join(' | ')}`, annotations: paragraph(texts.map((t) => characters(t))) },
      { name: `block: ${texts.join(' | ')}`, annotations: block(texts.map((t) => characters(t))) }
    ])
  ]
}
