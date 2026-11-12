/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helpers. */
/**
 * The last word of a line is looked up whole on the overlay, with Yomitan's Layout-aware scan on
 * (its default) or off.
 *
 * A read from a line's last word runs out of text, and the vendored `DOMTextScanner#seek` leaves
 * the range's end on the last node it passed, at the end of the document. When a `data-no-scan`
 * node (the hook card's controls, the hint bar) lies between, `TextScanner#_constrainTextSource`
 * sees it in the range and trims the word (`食べました` → `食べまし`; diagnosed in PR #131). So
 * Kimochi keeps every `data-no-scan` node ahead of the text that is looked up: the hint bar first
 * on the page, then the card, whose line is its own last child, then the OCR'd text.
 *
 * These build the overlay with the real `createHookCard` and `createOverlayHints` over a small
 * linked DOM, and read it with the vendored `TextScanner`, `TextSourceRange`, `DOMTextScanner`
 * and `TextSourceGenerator` (the probe from PR #131's review), so a change to either side fails
 * here. Credit to omer681 for the diagnosis.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// --- A linked DOM: what the scanner walks and what the card and the hint bar are built with. ----

globalThis.Node ??= { ELEMENT_NODE: 1, TEXT_NODE: 3 }

class FakeNode {
  constructor() {
    this.parentNode = null
    this.childNodes = []
  }
  get firstChild() {
    return this.childNodes[0] ?? null
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null
  }
  get nextSibling() {
    return this.#sibling(1)
  }
  get previousSibling() {
    return this.#sibling(-1)
  }
  #sibling(step) {
    const siblings = this.parentNode?.childNodes
    return siblings?.[siblings.indexOf(this) + step] ?? null
  }
  remove() {
    const siblings = this.parentNode?.childNodes
    if (siblings) siblings.splice(siblings.indexOf(this), 1)
    this.parentNode = null
  }
  after(...nodes) {
    this.parentNode.insertBefore(nodes, this.nextSibling)
  }
  before(...nodes) {
    this.parentNode.insertBefore(nodes, this)
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super()
    this.nodeType = 3
    this.nodeName = '#text'
    this.nodeValue = value
  }
  get textContent() {
    return this.nodeValue
  }
  set textContent(value) {
    this.nodeValue = value
  }
  cloneNode() {
    return new FakeText(this.nodeValue)
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super()
    this.nodeType = 1
    this.nodeName = tag.toUpperCase()
    this.tagName = this.nodeName
    this.attributes = new Map()
    this.classes = new Set()
    this.style = {
      setProperty(name, value) {
        this[name] = value
      },
      removeProperty(name) {
        delete this[name]
      }
    }
    this.dataset = {}
    this.classList = {
      add: (...names) => names.forEach((n) => this.classes.add(n)),
      remove: (...names) => names.forEach((n) => this.classes.delete(n)),
      toggle: (name, on = !this.classes.has(name)) => (on ? this.classes.add(name) : this.classes.delete(name), on),
      contains: (name) => this.classes.has(name)
    }
    this.offsetLeft = this.offsetTop = this.offsetWidth = this.offsetHeight = 0
    this.scrollWidth = this.clientWidth = 0
  }
  get className() {
    return [...this.classes].join(' ')
  }
  set className(value) {
    this.classes = new Set(value.split(' ').filter(Boolean))
  }
  get id() {
    return this.attributes.get('id') ?? ''
  }
  get hidden() {
    return this.attributes.has('hidden')
  }
  set hidden(on) {
    this.toggleAttribute('hidden', on)
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }
  hasAttribute(name) {
    return this.attributes.has(name)
  }
  removeAttribute(name) {
    this.attributes.delete(name)
  }
  toggleAttribute(name, on = !this.attributes.has(name)) {
    if (on) this.attributes.set(name, '')
    else this.attributes.delete(name)
    return on
  }
  set innerHTML(_html) {}
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('')
  }
  set textContent(value) {
    for (const child of [...this.childNodes]) child.remove()
    if (value) this.append(new FakeText(value))
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1)
  }
  get firstElementChild() {
    return this.children[0] ?? null
  }
  get nextElementSibling() {
    for (let next = this.nextSibling; next; next = next.nextSibling) if (next.nodeType === 1) return next
    return null
  }
  insertBefore(nodes, reference) {
    for (const item of [nodes].flat()) {
      const node = typeof item === 'string' ? new FakeText(item) : item
      node.remove()
      node.parentNode = this
      const at = reference ? this.childNodes.indexOf(reference) : -1
      if (at < 0) this.childNodes.push(node)
      else this.childNodes.splice(at, 0, node)
    }
    return nodes
  }
  append(...nodes) {
    this.insertBefore(nodes, null)
  }
  prepend(...nodes) {
    this.insertBefore(nodes, this.firstChild)
  }
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) child.remove()
    this.append(...nodes)
  }
  cloneNode(deep) {
    const copy = new FakeElement(this.nodeName.toLowerCase())
    copy.attributes = new Map(this.attributes)
    copy.classes = new Set(this.classes)
    Object.assign(copy.style, this.style)
    if (deep) copy.append(...this.childNodes.map((c) => c.cloneNode(true)))
    return copy
  }
  /** The two selectors the scanner is given here: `[attr]` and `[attr] *`. */
  matches(selector) {
    return selector.split(',').some((part) => {
      const s = part.trim()
      const attr = /^\[([\w-]+)\]$/.exec(s)
      if (attr) return this.attributes.has(attr[1])
      const within = /^\[([\w-]+)\] \*$/.exec(s)
      if (within) {
        for (let up = this.parentNode; up; up = up.parentNode) if (up.attributes?.has(within[1])) return true
        return false
      }
      throw Error(`fake matches() cannot parse ${s}`)
    })
  }
  querySelectorAll(selector) {
    const cls = /^\.([\w-]+)$/.exec(selector)
    if (!cls) throw Error(`fake querySelectorAll() cannot parse ${selector}`)
    const out = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue
        if (child.classes.has(cls[1])) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  addEventListener() {}
  getAnimations() {
    return []
  }
  /** A fade that is still running: the ghost stays in the card while a test reads it. */
  animate() {
    return {}
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
}

globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (value) => new FakeText(value)
}
globalThis.window ??= {}
globalThis.addEventListener = () => {}
globalThis.innerWidth = 1280
globalThis.innerHeight = 720
globalThis.matchMedia = () => ({ matches: false })

/** The styles that matter to a read: overlay.html, overlay-text.css, hook-card.css, overlay-hints.css. */
const BY_CLASS = {
  'hook-card': { position: 'absolute', display: 'block' },
  'hook-card-bar': { position: 'absolute', display: 'block' },
  'hook-card-controls': { position: 'absolute', display: 'flex' },
  'hook-card-resize': { position: 'absolute', display: 'block' },
  'hook-card-menu': { position: 'absolute', display: 'block' },
  'hook-card-text': { display: 'block' },
  'hook-card-text-ghost': { position: 'absolute', display: 'block' },
  'overlay-hints': { position: 'fixed', display: 'flex' },
  'ocr-word': { position: 'absolute', display: 'inline-flex' },
  'ocr-word-text': { display: 'block' },
  'ocr-group': { position: 'absolute', display: 'block' }
}
const BASE = {
  display: 'inline',
  position: 'static',
  visibility: 'visible',
  opacity: '1',
  fontSize: '16px',
  color: 'rgb(0, 0, 0)',
  userSelect: 'auto',
  webkitUserSelect: 'auto',
  whiteSpace: 'normal'
}
globalThis.window.getComputedStyle = globalThis.getComputedStyle = (node) => {
  const style = {
    ...BASE,
    display: ['DIV', 'BODY'].includes(node.nodeName) ? 'block' : 'inline'
  }
  if (
    node.attributes.get('id') === 'words' ||
    node.attributes.get('id') === 'hover' ||
    node.attributes.get('id') === 'controller'
  )
    Object.assign(style, { position: 'absolute', display: 'block' })
  for (const name of node.classes) Object.assign(style, BY_CLASS[name])
  if (node.hidden) style.display = 'none'
  return style
}

const { TextScanner } = await import('../extensions/yomitan/js/language/text-scanner.js')
const { TextSourceRange } = await import('../extensions/yomitan/js/dom/text-source-range.js')
const { TextSourceGenerator } = await import('../extensions/yomitan/js/dom/text-source-generator.js')
const { createHookCard } = await import('../ui/hook-card.js')
const { createOverlayHints } = await import('../ui/overlay-hints.js')

const NO_SCAN = '[data-no-scan], [data-no-scan] *'

class FakeRange {
  constructor(startContainer, startOffset, endContainer = startContainer, endOffset = startOffset) {
    Object.assign(this, {
      startContainer,
      startOffset,
      endContainer,
      endOffset
    })
  }
  setStart(node, offset) {
    Object.assign(this, { startContainer: node, startOffset: offset })
  }
  setEnd(node, offset) {
    Object.assign(this, { endContainer: node, endOffset: offset })
  }
  cloneRange() {
    return new FakeRange(this.startContainer, this.startOffset, this.endContainer, this.endOffset)
  }
  toString() {
    return ''
  }
  getBoundingClientRect() {
    return {}
  }
}

const make = (tag, className, ...children) => {
  const element = new FakeElement(tag)
  if (className) element.className = className
  element.append(...children.map((c) => (typeof c === 'string' ? new FakeText(c) : c)))
  return element
}

/** A word box as render.js draws it in word mode: its own text, then the bubble's text after it. */
const wordBox = (current, ahead) =>
  make(
    'span',
    'ocr-word',
    make('span', 'ocr-word-text', make('span', 'ocr-word-current', current), make('span', 'ocr-lookahead', ahead))
  )
/** A grouped region: one card per bubble, its text in runs. */
const group = (value) => make('div', 'ocr-group', make('span', 'ocr-run', value), make('span', 'ocr-lookahead'))
const textOf = (box) => box.firstChild.firstChild.firstChild

/**
 * overlay.html's body, built as overlay.js builds it: the card, then the hint bar, each shown,
 * then the OCR'd text drawn into `#words`, two bubbles: 猫が食べました。 and 犬が走った。.
 * `mode: 'words'` draws word boxes (猫が|食べ|ました。 and 犬が|走った。), `'groups'` one region
 * per bubble, `'none'` nothing (the Text Hooker's card shows the line instead). `cardShown: false`
 * hides the card (OCR'd text is shown), `hintsShown: false` the hint bar (closed by the reader);
 * `card: false, hints: false` leaves the controls out.
 */
function overlay({
  mode = 'words',
  card = true,
  cardShown = true,
  hints = true,
  hintsShown = true,
  menuOpen = false,
  ghost = false,
  example = false
} = {}) {
  const body = make('body')
  const words = make('div')
  words.setAttribute('id', 'words')
  const hover = make('div')
  hover.setAttribute('id', 'hover')
  const controller = make('div')
  controller.setAttribute('id', 'controller')
  body.append('\n    ', words, '\n    ', hover, '\n    ', controller, '\n    ', make('script'), '\n  ')
  const result = { body, texts: [] }
  if (card) {
    const none = () => undefined
    const hookCard = createHookCard(body, {
      onMoved: none,
      onDrag: none,
      onTextSize: none,
      onOpacity: none,
      onSettings: none
    })
    const line = {
      x: 40,
      y: 40,
      width: 300,
      height: 24,
      fontPx: 16,
      lineHeight: 1.5,
      lines: 0,
      example
    }
    hookCard.show({ ...line, text: ghost ? '前の行' : '猫が食べました' })
    if (ghost) hookCard.show({ ...line, text: '猫が食べました' })
    if (menuOpen) for (const menu of hookCard.element.querySelectorAll('.hook-card-menu')) menu.hidden = false
    if (!cardShown) hookCard.show(null)
    result.card = hookCard.element
    // Its first text node, in a row of its own or not.
    let first = hookCard.element.querySelectorAll('.hook-card-text')[0]
    while (first.firstChild) first = first.firstChild
    result.cardText = first
    result.menuLabel = hookCard.element.querySelectorAll('.hook-card-menu-label')[0]?.firstChild
  }
  if (hints) {
    const bar = createOverlayHints(body, { onDismiss() {} })
    bar.sync(hintsShown, true)
    result.hints = bar.element
  }
  if (mode === 'words') {
    const spec = [
      ['猫が', '食べました。'],
      ['食べ', 'ました。'],
      ['ました。', ''],
      ['犬が', '走った。'],
      ['走った。', '']
    ]
    const boxes = spec.map(([current, ahead]) => wordBox(current, ahead))
    words.append(...boxes)
    result.texts = boxes.map(textOf)
  } else if (mode === 'groups') {
    const groups = [group('猫が食べました。'), group('犬が走った。')]
    words.append(...groups)
    result.texts = groups.map((g) => g.firstChild.firstChild)
  }
  return result
}

/** What a frontend's scanner reads from character `offset` of `node`, as frontend-mode.js sets it up. */
function lookup(node, offset, layoutAwareScan, length = 16) {
  const scanner = new TextScanner({})
  scanner.includeSelector = null
  scanner.excludeSelector = NO_SCAN
  return scanner.getTextSourceContent(
    TextSourceRange.create(new FakeRange(node, offset)),
    length,
    layoutAwareScan,
    'mouse'
  )
}
/** The word a lookup can match: up to the first line break (Yomitan matches no further). */
const term = (read) => read.split('\n')[0].trimEnd()

const SENTENCE_ENDS = new Map([['。', [true, false]]])
/** The sentence an Anki card gets for `length` characters from `offset` of `node`. */
function sentence(node, offset, length, layoutAwareScan) {
  const source = TextSourceRange.create(new FakeRange(node, offset))
  source.setEndOffset(length, false, layoutAwareScan)
  return new TextSourceGenerator().extractSentence(
    source,
    layoutAwareScan,
    50,
    true,
    SENTENCE_ENDS,
    new Map(),
    new Map()
  ).text
}

const BOTH = [true, false]

test("Kimochi's unscanned controls come before every text that is looked up", () => {
  const { body, card, hints } = overlay()
  const elements = body.childNodes.filter((n) => n.nodeType === 1)
  assert.deepEqual(elements.slice(0, 3), [hints, card, elements.find((n) => n.id === 'words')])
  // In the card, the line is last: the bar, the buttons, the corner and the menu are before it.
  assert.ok(card.lastChild.classes.has('hook-card-text'))
  for (const child of card.childNodes.slice(0, -1)) assert.ok(child.hasAttribute('data-no-scan'))
  // Made in the other order, the card still goes after the hint bar.
  const other = make('body', '', make('div'))
  const bar = createOverlayHints(other, { onDismiss() {} }).element
  const late = createHookCard(other, {}).element
  assert.deepEqual(other.childNodes.slice(0, 2), [bar, late])
})

test('the last word of a line is read whole, with Layout-aware scan on or off', () => {
  // OCR'd text, the card hidden, the hint bar shown or closed: the page's last line runs out of text.
  for (const [mode, hintsShown] of [
    ['words', true],
    ['words', false],
    ['groups', true],
    ['groups', false]
  ]) {
    const last = overlay({ mode, cardShown: false, hintsShown }).texts.at(-1)
    const from = mode === 'words' ? 0 : 2
    for (const layoutAwareScan of BOTH) {
      const at = `${mode}, hints ${hintsShown}, layoutAwareScan ${layoutAwareScan}`
      assert.equal(lookup(last, from, layoutAwareScan).trimEnd(), '走った。', at)
      assert.equal(lookup(last, from + 1, layoutAwareScan).trimEnd(), 'った。', at)
    }
  }
  // The Text Hooker: the card's line, with and without the hint bar, and with OCR'd text too.
  for (const shape of [{ mode: 'none' }, { mode: 'none', hints: false }, { mode: 'groups' }]) {
    const { cardText } = overlay(shape)
    for (const layoutAwareScan of BOTH) {
      const at = JSON.stringify({ ...shape, layoutAwareScan })
      assert.ok(lookup(cardText, 2, layoutAwareScan).startsWith('食べました'), at)
      assert.ok(lookup(cardText, 3, layoutAwareScan).startsWith('べました'), at)
    }
    assert.equal(term(lookup(cardText, 2, true)), '食べました')
  }
})

test("the card's line reads whole while its old line fades out, and with the menu open", () => {
  for (const shape of [{ ghost: true }, { menuOpen: true }, { ghost: true, menuOpen: true }]) {
    const { card, cardText } = overlay({
      ...shape,
      hints: false,
      mode: 'none'
    })
    if (shape.ghost) assert.equal(card.querySelectorAll('.hook-card-text-ghost').length, 1)
    for (const layoutAwareScan of BOTH)
      assert.equal(
        lookup(cardText, 2, layoutAwareScan).trimEnd(),
        '食べました',
        JSON.stringify({ ...shape, layoutAwareScan })
      )
  }
})

test('a lookup never runs from one bubble or word box into the next (Layout-aware scan on)', () => {
  const words = overlay({ mode: 'words' }).texts
  // From 食べ: its own text and the bubble's text after it, then a break before the next box.
  assert.equal(term(lookup(words[1], 0, true)), '食べました。')
  assert.equal(term(lookup(words[2], 0, true)), 'ました。')
  assert.equal(term(lookup(words[2], 1, true)), 'した。')
  const { texts, cardText } = overlay({ mode: 'groups' })
  assert.equal(term(lookup(texts[0], 2, true)), '食べました。')
  assert.equal(term(lookup(cardText, 0, true)), '猫が食べました')
})

test('text inside a data-no-scan control still reads nothing', () => {
  const { menuLabel, hints } = overlay({ menuOpen: true })
  const hintText = hints.firstChild.firstChild
  for (const layoutAwareScan of BOTH) {
    assert.equal(lookup(menuLabel, 0, layoutAwareScan), '')
    assert.equal(lookup(hintText, 0, layoutAwareScan), '')
  }
  // An example card (no line yet) is not looked up either.
  const example = overlay({ example: true })
  for (const layoutAwareScan of BOTH) assert.equal(lookup(example.cardText, 0, layoutAwareScan), '')
})

test("Anki sentences are what they are without Kimochi's controls on the page", () => {
  // [mode, line, offset, length, sentence with Layout-aware scan on]
  const cases = [
    ['words', 0, 0, 2, '猫が食べました'],
    ['words', 1, 0, 5, '食べました'],
    ['words', 4, 0, 4, '走った。'],
    ['groups', 0, 2, 5, '猫が食べました'],
    ['groups', 1, 2, 4, '犬が走った。']
  ]
  for (const [mode, line, offset, length, expected] of cases) {
    const at = `${mode} line ${line}`
    for (const shape of [{ menuOpen: true }, { card: false, hints: false }])
      assert.equal(sentence(overlay({ mode, ...shape }).texts[line], offset, length, true), expected, at)
  }
  // The card's own line is its own sentence.
  assert.equal(sentence(overlay().cardText, 2, 5, true), '猫が食べました')
})
