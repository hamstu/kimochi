import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installPanelController } from '../ui/panel-controller.js'
import { editKeyboardBuffer, supportsControllerKeyboard, commitKeyboardValue, openControllerKeyboard } from '../ui/controller-keyboard.js'

const state = (value, start = value.length, end = start) => ({ value, start, end })
test('controller edits replace selections and move caret without changing content', () => {
  assert.deepEqual(editKeyboardBuffer(state('hello', 1, 4), { type: 'insert', text: 'i' }), state('hio', 2))
  assert.deepEqual(editKeyboardBuffer(state('hello', 1, 4), { type: 'left' }), state('hello', 1))
  assert.deepEqual(editKeyboardBuffer(state('hello', 1, 4), { type: 'right' }), state('hello', 4))
  assert.deepEqual(editKeyboardBuffer(state('hello', 0), { type: 'backspace' }), state('hello', 0))
})
test('deletion preserves supplementary characters and handles selection and boundaries', () => {
  assert.deepEqual(editKeyboardBuffer(state('a😀'), { type: 'backspace' }), state('a'))
  assert.deepEqual(editKeyboardBuffer(state('😀b', 0), { type: 'delete' }), state('b', 0))
  assert.deepEqual(editKeyboardBuffer(state('日本語', 0, 2), { type: 'backspace' }), state('語', 0))
  assert.deepEqual(editKeyboardBuffer(state('a😀b', 3), { type: 'left' }), state('a😀b', 1))
  assert.deepEqual(editKeyboardBuffer(state('a😀b', 1), { type: 'right' }), state('a😀b', 3))
})
test('only supported editable text fields open keyboard, excluding nested editors', () => {
  const element = { tagName: 'INPUT', type: 'text', hasAttribute: () => false }
  for (const type of ['text', 'search', 'url', 'email', 'tel', 'password']) assert.equal(supportsControllerKeyboard({ ...element, type }), true)
  for (const type of ['file', 'color', 'range', 'number', 'checkbox', 'radio', 'hidden']) assert.equal(supportsControllerKeyboard({ ...element, type }), false)
  assert.equal(supportsControllerKeyboard({ ...element, readOnly: true }), false)
  assert.equal(supportsControllerKeyboard({ ...element, disabled: true }), false)
  assert.equal(supportsControllerKeyboard({ ...element, hasAttribute: () => true }), false)
})

function dom() {
  const listeners = new Map()
  let setterCalls = 0
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = new Map(); this.dataset = {}; this.events = []; this.listeners = new Map(); this.selectionStart = 0; this.selectionEnd = 0; this._value = ''; this.isConnected = true; this.ownerDocument = doc }
    get value() { return this._value }
    set value(value) { setterCalls++; this._value = value }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this } }
    remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this) }
    setAttribute(key, value) { this.attrs.set(key, value) }
    hasAttribute(key) { return this.attrs.has(key) }
    getAttribute(key) { return this.attrs.get(key) ?? null }
    addEventListener(key, listener) { this.listeners.set(key, listener) }
    dispatchEvent(event) { this.events.push(event.type); this.listeners.get(event.type)?.(event); return true }
    click() { this.listeners.get('click')?.({}) }
    focus() { doc.activeElement = this }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)) }
    querySelectorAll(selector) {
      const all = []
      for (const child of this.children) {
        if (selector === 'button' ? child.tagName === 'BUTTON' : selector.startsWith('[role="dialog"]') ? child.getAttribute('role') === 'dialog' : selector.includes('button') && ['BUTTON', 'INPUT', 'TEXTAREA'].includes(child.tagName)) all.push(child)
        all.push(...child.querySelectorAll(selector))
      }
      return all
    }
    querySelector(selector) { return this.querySelectorAll('button').find((button) => selector === '[data-modal-action="hide"]' && button.getAttribute('data-modal-action') === 'hide') ?? null }
    closest() { return null }
    getBoundingClientRect() { return { left: 0, top: 0, width: 40, height: 40, right: 40, bottom: 40 } }
    matches() { return false }
    removeAttribute(key) { this.attrs.delete(key) }

    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end }
  }
  const doc = {
    createElement: (tag) => new Node(tag),
    addEventListener: (key, listener) => listeners.set(key, listener),
    removeEventListener: (key) => listeners.delete(key),
    defaultView: { HTMLInputElement: Node, HTMLTextAreaElement: Node, Event: class { constructor(type) { this.type = type } } }
  }
  doc.visibilityState = 'visible'
  doc.hasFocus = () => true
  doc.querySelector = () => null
  doc.querySelectorAll = (selector) => doc.body.querySelectorAll(selector)
  doc.documentElement = new Node('html')
  Object.assign(doc.defaultView, { document: doc, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {}, dispatchEvent() {} })
  doc.body = new Node('body')
  const target = new Node('input')
  target.type = 'text'; target.value = 'old'; target.setSelectionRange(3, 3); target.maxLength = -1
  doc.body.append(target); doc.activeElement = target
  return { doc, target, listeners, setterCalls: () => setterCalls }
}

test('Done commits native setter and bubbles input/change, cancel preserves original and focus', () => {
  const h = dom()
  const keyboard = openControllerKeyboard(h.target)
  const buttons = keyboard.dialog.querySelectorAll('button')
  assert.equal(h.target.value, 'old')
  assert.equal(h.doc.activeElement.textContent, '1')
  buttons.find((button) => button.textContent === 'a').click()
  assert.equal(keyboard.editor.value, 'olda')
  assert.equal(h.target.value, 'old', 'draft never leaks into controlled field')
  buttons.find((button) => button.textContent === 'Done').click()
  assert.equal(h.target.value, 'olda')
  assert.deepEqual(h.target.events, ['input', 'change'])
  assert.equal(h.doc.activeElement, h.target)
  assert.equal(h.listeners.size, 0)
  const second = openControllerKeyboard(h.target)
  second.editor.value = 'discard'
  second.dialog.querySelectorAll('button').find((button) => button.textContent === 'Cancel').click()
  assert.equal(h.target.value, 'olda')
  assert.equal(h.doc.activeElement, h.target)
})
test('B/Escape cancels, physical Tab stays contained and password stays masked', () => {
  const h = dom(); h.target.type = 'password'
  const keyboard = openControllerKeyboard(h.target)
  assert.equal(keyboard.editor.type, 'password')
  let prevented = 0
  h.listeners.get('keydown')({ key: 'Tab', shiftKey: true, preventDefault: () => prevented++ })
  assert.equal(keyboard.dialog.contains(h.doc.activeElement), true)
  keyboard.editor.value = 'draft'
  h.listeners.get('keydown')({ key: 'Escape', preventDefault: () => prevented++, stopPropagation() {} })
  assert.equal(prevented, 2)
  assert.equal(h.target.value, 'old')
  assert.equal(keyboard.dialog.isConnected, false)
  assert.equal(h.listeners.size, 0)
})
test('unchanged commits do not emit false changes and controller respects maxlength', () => {
  const h = dom(); assert.equal(commitKeyboardValue(h.target, 'old'), false)
  assert.equal(h.target.events.length, 0)
  h.target.maxLength = 3
  const keyboard = openControllerKeyboard(h.target)
  const buttons = keyboard.dialog.querySelectorAll('button')
  buttons.find((button) => button.textContent === 'a').click()
  assert.equal(keyboard.editor.value, 'old')
  buttons.find((button) => button.getAttribute('aria-label') === 'Backspace').click()
  assert.equal(keyboard.editor.value, 'ol')
  keyboard.close(false)
})


test('panel snapshot A opens keyboard and B cancels modal rather than closing app', () => {
  const h = dom()
  let panelBacks = 0
  const controller = installPanelController(h.doc.defaultView, { onBack: () => { panelBacks++; return true } })
  const snapshot = (buttons) => controller.snapshot({ activeGamepadIndex: 0, buttonStates: buttons, axisStates: [] })
  snapshot([]); snapshot([true])
  const dialog = h.doc.querySelectorAll('[role="dialog"]')[0]
  assert.equal(dialog.getAttribute('aria-label'), 'Controller keyboard')
  dialog.querySelectorAll('button').find((button) => button.textContent === 'a').click()
  snapshot([]); snapshot([false, true])
  assert.equal(dialog.isConnected, false)
  assert.equal(h.target.value, 'old')
  assert.equal(h.doc.activeElement, h.target)
  assert.equal(panelBacks, 0)
  controller.destroy()
})
