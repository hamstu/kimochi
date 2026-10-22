/**
 * `withTextShown` (host/ext/content.js): 10ten skips text at opacity 0, which is how the overlay
 * holds its text while the controller reads, so a controller lookup shows it for the one event
 * and puts it back, never leaving the overlay changed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTextShown } from '../host/ext/content.js'

function element(opacity, parentElement = null) {
  const props = new Map()
  return {
    nodeType: 1,
    parentElement,
    computed: opacity,
    style: {
      getPropertyValue: (name) => props.get(name)?.[0] ?? '',
      getPropertyPriority: (name) => props.get(name)?.[1] ?? '',
      setProperty: (name, value, priority = '') => props.set(name, [value, priority]),
      removeProperty: (name) => props.delete(name)
    }
  }
}

const win = {
  getComputedStyle: (el) => ({ opacity: el.style.getPropertyValue('opacity') || el.computed })
}

test('opacity-0 text and ancestors are shown for the event only, and restored after', () => {
  const box = element('1')
  const text = element('0', box)
  text.style.setProperty('opacity', '0')
  const span = element('1', text)
  let seen = null
  const result = withTextShown(win, span, () => {
    seen = [span, text, box].map((el) => win.getComputedStyle(el).opacity)
    return 'done'
  })
  assert.equal(result, 'done')
  assert.deepEqual(seen, ['1', '0.001', '1'])
  assert.equal(text.style.getPropertyValue('opacity'), '0', 'its own inline value is back')
  assert.equal(box.style.getPropertyValue('opacity'), '', 'untouched elements stay untouched')
})

test('a throw still restores the text', () => {
  const text = element('0')
  assert.throws(() => withTextShown(win, text, () => { throw Error('boom') }))
  assert.equal(text.style.getPropertyValue('opacity'), '')
  assert.equal(win.getComputedStyle(text).opacity, '0')
})
