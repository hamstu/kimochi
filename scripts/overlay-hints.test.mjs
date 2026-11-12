// The overlay's hint bar (ui/overlay-hints.js): the Shift hint on desktops, and in Steam Deck
// Gaming Mode the button that opens the game menu instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Just enough DOM for the hint bar: elements with text, children, classes and attributes. */
class Node {
  constructor(text = '') {
    this.text = text
    this.children = []
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join('')
  }
  set textContent(value) {
    this.text = value
    this.children = []
  }
}
class Element extends Node {
  constructor(tag) {
    super()
    this.tag = tag
    this.attributes = new Map()
    this.hidden = false
    this.style = { removeProperty() {} }
    const classes = new Set()
    this.classList = {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name)
    }
    Object.defineProperty(this, 'className', {
      set: (v) => {
        for (const c of v.split(' ')) classes.add(c)
      },
      get: () => [...classes].join(' ')
    })
  }
  setAttribute(name, value) {
    this.attributes.set(name, value)
  }
  removeAttribute(name) {
    this.attributes.delete(name)
  }
  toggleAttribute() {}
  addEventListener() {}
  append(...nodes) {
    this.children.push(...nodes)
  }
  prepend(...nodes) {
    this.children.unshift(...nodes)
  }
  replaceChildren(...nodes) {
    this.children = [...nodes]
  }
  set innerHTML(_html) {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0 }
  }
}
globalThis.document = {
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => new Node(text)
}
globalThis.window = {}

const { createOverlayHints } = await import('../ui/overlay-hints.js')

test('desktops say what Shift does', () => {
  const parent = new Element('body')
  const hints = createOverlayHints(parent, { onDismiss() {} })
  hints.sync(true, true)
  assert.equal(hints.element.textContent, 'Hold Shift to look up words and click text')
  hints.sync(true, false)
  assert.equal(hints.element.textContent, 'Hold Shift over a word to look it up')
})

test('Gaming Mode names the game-menu buttons instead of Shift, at handheld size', () => {
  const hints = createOverlayHints(new Element('body'), { onDismiss() {} })
  hints.gaming(['L4'])
  hints.sync(true, true)
  assert.equal(hints.element.textContent, 'Press L4 for the game menu to read words')
  assert.ok(hints.element.classList.contains('overlay-hints-gaming'))
  hints.gaming(['View', 'Menu'])
  assert.equal(hints.element.textContent, 'Press View + Menu for the game menu to read words')
  assert.doesNotMatch(hints.element.textContent, /Shift/)
})

test('Gaming Mode with no button bound points to Settings', () => {
  const hints = createOverlayHints(new Element('body'), { onDismiss() {} })
  hints.gaming([])
  assert.match(hints.element.textContent, /Choose a button for the game menu in Kimochi’s Settings/)
})

test('leaving Gaming Mode brings the Shift hint back', () => {
  const hints = createOverlayHints(new Element('body'), { onDismiss() {} })
  hints.sync(true, true)
  hints.gaming(['L4'])
  hints.gaming(null)
  hints.sync(true, true)
  assert.equal(hints.element.textContent, 'Hold Shift to look up words and click text')
  assert.ok(!hints.element.classList.contains('overlay-hints-gaming'))
})
