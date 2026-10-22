/**
 * The controller's focus over a dictionary pop-up's buttons (ui/popup-focus.js): where it starts,
 * where the D-pad takes it, and what A and X press. Driven over a small stand-in for the DOM, laid
 * out the way Yomitan's pop-up is: entries one under another, each with Add and Play audio.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPopupFocus,
  nearestInDirection,
  FOCUS_ATTRIBUTE,
  YOMITAN_FOCUS,
  HACHIDORI_FOCUS
} from '../ui/popup-focus.js'

/** A selector the stand-in understands: `.a`, `.a.b`, `[x="y"]`, `:not(...)`, lists with commas. */
function matches(element, selector) {
  return selector.split(',').some((part) => {
    let rest = part.trim()
    const nots = []
    rest = rest.replace(/:not\(([^)]*)\)/g, (_, inner) => (nots.push(inner), ''))
    if (nots.some((inner) => matches(element, inner))) return false
    const attrs = [...rest.matchAll(/\[([\w-]+)="([^"]*)"\]/g)]
    rest = rest.replace(/\[[^\]]*\]/g, '')
    const classes = rest.split('.').filter(Boolean)
    return (
      classes.every((name) => element.classes.has(name)) &&
      attrs.every(([, name, value]) => element.attributes[name] === value)
    )
  })
}

function node(classes, rect = null, attributes = {}) {
  const element = {
    classes: new Set(classes.split(' ').filter(Boolean)),
    attributes: { ...attributes },
    children: [],
    parent: null,
    rect,
    hidden: false,
    disabled: false,
    clicks: 0,
    isConnected: true,
    nodeType: 1,
    append(...children) {
      for (const child of children) {
        child.parent = element
        element.children.push(child)
      }
      return element
    },
    descendants() {
      return element.children.flatMap((child) => [child, ...child.descendants()])
    },
    querySelectorAll: (selector) => element.descendants().filter((d) => matches(d, selector)),
    querySelector: (selector) => element.querySelectorAll(selector)[0] ?? null,
    matches: (selector) => matches(element, selector),
    closest(selector) {
      for (let at = element; at; at = at.parent) if (at.matches?.(selector)) return at
      return null
    },
    getBoundingClientRect: () => element.rect ?? { left: 0, top: 0, width: 0, height: 0, bottom: 0 },
    setAttribute(name, value) {
      element.attributes[name] = value
    },
    removeAttribute(name) {
      delete element.attributes[name]
    },
    getRootNode: () => root,
    scrollIntoView() {},
    click() {
      element.clicks++
    }
  }
  return element
}

const rect = (left, top, width = 40, height = 24) => ({ left, top, width, height, bottom: top + height })

/** The document-like root the focus adds its stylesheet to. */
let root
function popup() {
  const styles = []
  const body = node('content-body', rect(0, 0, 400, 600))
  root = {
    nodeType: 11,
    styles,
    ownerDocument: {
      createElement: () => ({ id: '', textContent: '' })
    },
    querySelector: (selector) => styles.find((style) => `#${style.id}` === selector) ?? null,
    append: (style) => styles.push(style)
  }
  const entry = (top, current = false) => {
    const element = node(`entry${current ? ' entry-current' : ''}`, rect(0, top, 400, 180))
    const audio = node('action-button', rect(10, top + 10), { 'data-action': 'play-audio' })
    const menu = node('action-button', rect(300, top + 10), { 'data-action': 'menu' })
    const add = node('action-button', rect(350, top + 10), { 'data-action': 'save-note' })
    element.append(audio, menu, add)
    return { element, audio, menu, add }
  }
  const first = entry(0)
  const second = entry(200, true)
  const third = entry(400)
  body.append(first.element, second.element, third.element)
  return { body, entries: [first, second, third], styles }
}

const focusOn = (body) => createPopupFocus({ root: () => body, spec: YOMITAN_FOCUS })
const focusedIn = (body) => body.descendants().filter((d) => FOCUS_ATTRIBUTE in d.attributes)

test('entering starts on the current entry’s Add button, and draws the ring once', () => {
  const { body, entries, styles } = popup()
  const focus = focusOn(body)
  assert.equal(focus.enter(), true)
  assert.deepEqual(focusedIn(body), [entries[1].add])
  focus.enter()
  assert.equal(styles.length, 1, 'one stylesheet, however often it enters')
})

test('the D-pad moves to the nearest button that way, and stops at the edges', () => {
  const { body, entries } = popup()
  const focus = focusOn(body)
  focus.enter()
  assert.equal(focus.move('left'), true)
  assert.deepEqual(focusedIn(body), [entries[1].audio], 'the menu button is skipped')
  assert.equal(focus.move('left'), false)
  assert.deepEqual(focusedIn(body), [entries[1].audio], 'at the edge, the focus stays')
  assert.equal(focus.move('down'), true)
  assert.deepEqual(focusedIn(body), [entries[2].audio], 'down keeps the column')
  assert.equal(focus.move('down'), false)
  focus.move('up')
  focus.move('up')
  assert.deepEqual(focusedIn(body), [entries[0].audio])
})

test('A presses the focused button; X plays the focused entry’s audio', () => {
  const { body, entries } = popup()
  const focus = focusOn(body)
  assert.equal(focus.press(), false, 'nothing focused, nothing pressed')
  focus.enter()
  assert.equal(focus.press(), true)
  assert.equal(entries[1].add.clicks, 1)
  focus.move('down')
  assert.equal(focus.playAudio(), true)
  assert.equal(entries[2].audio.clicks, 1)
})

test('without the focus, X plays the current entry’s audio', () => {
  const { body, entries } = popup()
  assert.equal(focusOn(body).playAudio(), true)
  assert.equal(entries[1].audio.clicks, 1)
})

test('hidden and disabled buttons are never focused', () => {
  const { body, entries } = popup()
  entries[1].add.disabled = true
  entries[1].audio.hidden = true
  const focus = focusOn(body)
  focus.enter()
  // The current entry has nothing left to focus, so it starts on the topmost button instead.
  assert.deepEqual(focusedIn(body), [entries[0].audio])
  focus.move('down')
  focus.move('right')
  assert.notEqual(focusedIn(body)[0], entries[1].add)
  assert.notEqual(focusedIn(body)[0], entries[1].audio)
})

test('after a definition jump the focus moves to the new current entry', () => {
  const { body, entries } = popup()
  const focus = focusOn(body)
  focus.enter()
  entries[1].element.classes.delete('entry-current')
  entries[2].element.classes.add('entry-current')
  assert.equal(focus.refocus(), true)
  assert.deepEqual(focusedIn(body), [entries[2].add])
})

test('exit takes the ring away, and a replaced pop-up is no longer focused', () => {
  const { body, entries } = popup()
  const focus = focusOn(body)
  focus.enter()
  focus.exit()
  assert.deepEqual(focusedIn(body), [])
  focus.enter()
  entries[1].add.isConnected = false
  assert.equal(focus.active, false)
})

test('a pop-up without entries (Hachidori) starts on the topmost Add button', () => {
  const body = node('gsm-hoshidicts-popup', rect(0, 0, 400, 600))
  const pinned = node('gsm-hoshidicts-mine-button', rect(300, 4), { 'data-action': 'add' })
  const lower = node('gsm-hoshidicts-mine-button', rect(300, 300), { 'data-action': 'add' })
  const audio = node('gsm-hoshidicts-audio-button', rect(20, 4))
  body.append(lower, audio, pinned)
  popup() // for `root`
  const focus = createPopupFocus({ root: () => body, spec: HACHIDORI_FOCUS })
  assert.equal(focus.available(), true)
  focus.enter()
  assert.deepEqual(focusedIn(body), [pinned])
  assert.equal(focus.playAudio(), true)
  assert.equal(audio.clicks, 1)
})

test('direction finding prefers the same row or column over a closer button off to the side', () => {
  const from = rect(100, 100)
  // Right: one in the same row far off, one nearer but a row down.
  assert.equal(nearestInDirection(from, [rect(260, 100), rect(160, 150)], 'right'), 0)
  // Down: straight below beats diagonally nearer.
  assert.equal(nearestInDirection(from, [rect(160, 140), rect(100, 200)], 'down'), 1)
  // Buttons side by side are not above or below each other.
  assert.equal(nearestInDirection(from, [rect(150, 102)], 'down'), -1)
  assert.equal(nearestInDirection(from, [null, rect(40, 100)], 'left'), 1)
})
