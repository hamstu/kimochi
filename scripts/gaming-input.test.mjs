/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * Touch input in Steam Deck Gaming Mode (host/gaming-input.js): a drop-down list opens inside the
 * page, since Gamescope cannot show WebKitGTK's menu window under a finger, and a tap on a text
 * field asks Steam for its on-screen keyboard.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../host/gaming-input.js', import.meta.url), 'utf8')

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type
    this.defaultPrevented = false
    this.stopped = false
    Object.assign(this, init)
  }
  preventDefault() {
    this.defaultPrevented = true
  }
  stopPropagation() {
    this.stopped = true
  }
}

function element(doc, localName, props = {}) {
  const listeners = new Map()
  const node = {
    localName,
    ownerDocument: doc,
    children: [],
    parent: null,
    attributes: {},
    style: {},
    hidden: false,
    events: [],
    className: '',
    classList: { toggle() {} },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute(name) {
      return this.attributes[name] ?? null
    },
    append(...nodes) {
      for (const child of nodes) {
        child.parent = this
        this.children.push(child)
      }
    },
    remove() {
      const siblings = this.parent?.children
      if (siblings) siblings.splice(siblings.indexOf(this), 1)
      this.parent = null
    },
    attachShadow() {
      this.shadow = element(doc, '#shadow')
      return this.shadow
    },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    dispatchEvent(event) {
      this.events.push(event.type)
      event.target ??= this
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return !event.defaultPrevented
    },
    click() {
      this.dispatchEvent(new FakeEvent('click'))
    },
    closest(selector) {
      const names = selector.split(',').map((name) => name.trim())
      for (let at = this; at; at = at.parent) {
        if (names.includes(at.localName)) return at
        if (names.includes('[contenteditable]') && at.isContentEditable) return at
      }
      return null
    },
    focus() {
      doc.focused = this
    },
    getBoundingClientRect() {
      return this.box ?? { left: 0, top: 0, width: 0, height: 0 }
    },
    ...props
  }
  return node
}

function selectOf(doc, options, props = {}) {
  const select = element(doc, 'select', { selectedIndex: 0, multiple: false, size: 0, disabled: false, ...props })
  let index = 0
  const add = (parent, option) => {
    const node = element(doc, 'option', { label: option.label, disabled: !!option.disabled, hidden: !!option.hidden })
    node.index = index++
    parent.append(node)
  }
  for (const option of options) {
    if (option.group === undefined) add(select, option)
    else {
      const group = element(doc, 'optgroup', { label: option.group, disabled: !!option.disabled })
      select.append(group)
      option.options.forEach((inner) => add(group, inner))
    }
  }
  return select
}

/** A window with the script run in it. `platform` is `__KIMOCHI_PLATFORM__`. */
function page({ platform = { gamescope: true }, parent, invoke } = {}) {
  const listeners = new Map()
  const doc = { focused: null, frames: [] }
  doc.createElement = (name) => element(doc, name)
  doc.body = element(doc, 'body')
  doc.querySelectorAll = () => doc.frames
  const win = {
    document: doc,
    Event: FakeEvent,
    innerWidth: 640,
    innerHeight: 400,
    __KIMOCHI_PLATFORM__: platform,
    posted: [],
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((each) => each !== listener)
      )
    },
    fire(type, init = {}) {
      const event = new FakeEvent(type, init)
      for (const listener of listeners.get(type) ?? []) listener(event)
      return event
    },
    listening: (type) => (listeners.get(type) ?? []).length,
    postMessage(data) {
      this.posted.push(data)
    },
    getComputedStyle: () => ({ colorScheme: 'dark' })
  }
  win.parent = parent ?? win
  if (invoke) win.__TAURI_INTERNALS__ = { invoke }
  doc.defaultView = win
  vm.runInNewContext(source, { window: win, Promise, Math, Set, String, Date: clock })
  return { win, doc, api: win.__kimochiGamingInput }
}

/** The script's clock, moved by hand. */
const clock = { at: 1_000_000, now: () => clock.at }

const SECTIONS = [{ label: 'Dictionaries' }, { label: 'Reading' }, { label: 'Anki' }]
const picker = (doc) => doc.body.children.find((node) => 'data-kimochi-select-picker' in node.attributes)
const rowsOf = (doc) => picker(doc).shadow.children[1].children[0].children

test('outside Gaming Mode nothing is installed', () => {
  const { win, doc } = page({ platform: { gamescope: false } })
  const select = selectOf(doc, SECTIONS)
  assert.equal(win.fire('mousedown', { button: 0, target: select }).defaultPrevented, false)
  win.fire('click', { target: select })
  assert.equal(picker(doc), undefined)
})

test('a press on a drop-down list no longer opens the platform menu', () => {
  const { win, doc } = page()
  const select = selectOf(doc, SECTIONS)
  assert.equal(win.fire('mousedown', { button: 0, target: select }).defaultPrevented, true)
  // Not a right click, a list box, a multiple select or a disabled one: those have no menu.
  assert.equal(win.fire('mousedown', { button: 2, target: select }).defaultPrevented, false)
  for (const props of [{ multiple: true }, { size: 4 }, { disabled: true }]) {
    const other = selectOf(doc, SECTIONS, props)
    assert.equal(win.fire('mousedown', { button: 0, target: other }).defaultPrevented, false)
    win.fire('click', { target: other })
    assert.equal(picker(doc), undefined)
  }
})

test('one tap opens the list in the page and one more chooses', () => {
  const { win, doc } = page()
  const select = selectOf(doc, SECTIONS)
  win.fire('mousedown', { button: 0, target: select })
  // The list is not there for the same tap's release to land on.
  assert.equal(picker(doc), undefined)
  win.fire('click', { target: select })
  const rows = rowsOf(doc)
  assert.deepEqual(
    rows.map((row) => row.textContent),
    ['Dictionaries', 'Reading', 'Anki']
  )
  assert.equal(rows[0].attributes['aria-selected'], 'true')
  rows[2].click()
  assert.equal(select.selectedIndex, 2)
  assert.deepEqual(select.events, ['input', 'change'])
  assert.equal(picker(doc), undefined)
  assert.equal(doc.focused, select)
  assert.equal(win.listening('keydown'), 1, 'the open list stops listening for keys once closed')
})

test('choosing what is already chosen tells the page nothing', () => {
  const { win, doc } = page()
  const select = selectOf(doc, SECTIONS, { selectedIndex: 1 })
  win.fire('click', { target: select })
  rowsOf(doc)[1].click()
  assert.deepEqual(select.events, [])
  assert.equal(picker(doc), undefined)
})

test('a tap outside the list closes it and changes nothing', () => {
  const { win, doc } = page()
  const select = selectOf(doc, SECTIONS)
  win.fire('click', { target: select })
  picker(doc).shadow.children[1].click()
  assert.equal(picker(doc), undefined)
  assert.equal(select.selectedIndex, 0)
  assert.deepEqual(select.events, [])
})

test('groups are headings, and disabled or hidden options cannot be chosen', () => {
  const { win, doc, api } = page()
  const select = selectOf(doc, [
    { label: 'Auto' },
    { group: 'Japanese', options: [{ label: 'Mincho' }, { label: 'Gothic', disabled: true }] },
    { group: 'Unavailable', disabled: true, options: [{ label: 'Kai' }] },
    { label: 'Old', hidden: true }
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(api.pickerRows(select))), [
    { index: 0, label: 'Auto', disabled: false, selected: true },
    { group: 'Japanese' },
    { index: 1, label: 'Mincho', disabled: false, selected: false },
    { index: 2, label: 'Gothic', disabled: true, selected: false },
    { group: 'Unavailable' },
    { index: 3, label: 'Kai', disabled: true, selected: false }
  ])
  win.fire('click', { target: select })
  rowsOf(doc)[3].click()
  assert.equal(select.selectedIndex, 0)
  assert.ok(picker(doc), 'a disabled row leaves the list open')
})

test('the keyboard opens the list, moves through it and chooses', () => {
  const { win, doc } = page()
  const select = selectOf(doc, [{ label: 'One' }, { label: 'Two', disabled: true }, { label: 'Three' }])
  assert.equal(win.fire('keydown', { key: 'a', target: select }).defaultPrevented, false)
  assert.equal(win.fire('keydown', { key: 'Enter', target: select }).defaultPrevented, true)
  assert.ok(picker(doc))
  // Down skips the disabled row.
  win.fire('keydown', { key: 'ArrowDown' })
  win.fire('keydown', { key: 'Enter' })
  assert.equal(select.selectedIndex, 2)
  assert.equal(picker(doc), undefined)
  win.fire('keydown', { key: ' ', target: select })
  win.fire('keydown', { key: 'Escape' })
  assert.equal(picker(doc), undefined)
  assert.equal(select.selectedIndex, 2)
})

test('text goes into inputs, text areas and editable content only', () => {
  const { doc, api } = page()
  const input = (type, props) => element(doc, 'input', { type, ...props })
  for (const type of ['', 'text', 'search', 'url', 'email', 'password', 'number', 'tel', 'TEXT']) {
    assert.equal(api.isTextEntry(input(type)), true, type)
  }
  for (const type of ['checkbox', 'radio', 'range', 'file', 'button', 'color', 'date']) {
    assert.equal(api.isTextEntry(input(type)), false, type)
  }
  assert.equal(api.isTextEntry(element(doc, 'textarea')), true)
  assert.equal(api.isTextEntry(element(doc, 'div', { isContentEditable: true })), true)
  assert.equal(api.isTextEntry(element(doc, 'div')), false)
  assert.equal(api.isTextEntry(input('text', { readOnly: true })), false)
  assert.equal(api.isTextEntry(input('text', { disabled: true })), false)
  const none = input('text')
  none.setAttribute('inputmode', 'none')
  assert.equal(api.isTextEntry(none), false)
})

test('a tap on a text field asks for the keyboard, with where the field is', () => {
  const calls = []
  const { win, doc } = page({ invoke: (command, args) => calls.push([command, args]) })
  const field = element(doc, 'input', { type: 'text', box: { left: 160, top: 100, width: 320, height: 40 } })
  win.fire('click', { target: field })
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['gaming_keyboard_show', { x: 0.25, y: 0.25, width: 0.5, height: 0.1, multiline: false }]
  ])
  const area = element(doc, 'textarea', { box: { left: 0, top: 0, width: 640, height: 200 } })
  win.fire('click', { target: area })
  assert.equal(calls[1][1].multiline, true)
  // A button is not a text field.
  win.fire('click', { target: element(doc, 'button') })
  assert.equal(calls.length, 2)
})

test('a field that takes the focus just after a tap gets the keyboard; one focused unasked does not', () => {
  const calls = []
  const { win, doc } = page({ invoke: (command, args) => calls.push([command, args]) })
  const field = element(doc, 'textarea', { box: { left: 64, top: 300, width: 512, height: 40 } })
  // The page focuses a field as it loads: nobody asked to type.
  win.fire('focusin', { target: field })
  assert.equal(calls.length, 0)
  // "Add a note": the tap is on a button, and the page then puts the caret in the note.
  win.fire('click', { target: element(doc, 'button') })
  clock.at += 120
  win.fire('focusin', { target: field })
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['gaming_keyboard_show', { x: 0.1, y: 0.75, width: 0.8, height: 0.1, multiline: true }]
  ])
  // Long after the tap, a focus is the page's own again; and a button taking focus is not a field.
  clock.at += 5000
  win.fire('focusin', { target: field })
  win.fire('click', { target: element(doc, 'button') })
  win.fire('focusin', { target: element(doc, 'button') })
  assert.equal(calls.length, 1)
})

test('a frame that cannot reach native hands the request to its parent, which places it', () => {
  const calls = []
  const top = page({ invoke: (command, args) => calls.push([command, args]) })
  const frame = page({ parent: top.win })
  const field = element(frame.doc, 'input', { type: 'search', box: { left: 10, top: 20, width: 100, height: 30 } })
  frame.win.fire('click', { target: field })
  assert.equal(top.win.posted.length, 1)
  // The parent finds the frame the message came from and adds where it sits.
  top.doc.frames = [
    {
      contentWindow: frame.win,
      clientLeft: 0,
      clientTop: 0,
      getBoundingClientRect: () => ({ left: 0, top: 60 })
    }
  ]
  top.win.fire('message', { data: top.win.posted[0], source: frame.win })
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['gaming_keyboard_show', { x: 10 / 640, y: 80 / 400, width: 100 / 640, height: 30 / 400, multiline: false }]
  ])
  // Anything else posted to the window is not a request.
  top.win.fire('message', { data: { other: true }, source: frame.win })
  top.win.fire('message', { data: null, source: frame.win })
  assert.equal(calls.length, 1)
})
