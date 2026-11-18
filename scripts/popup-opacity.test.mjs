/**
 * Settings → Overlay → Dictionary pop-up opacity (`dictionaryPopupOpacity`): every engine's whole
 * pop-up is drawn at it, never below 10%, so it can always be read.
 * Yomitan's frame takes it inline (host/popup-bridge.js), Hachidori's and 10ten's shadow host from a
 * stylesheet (host/ext/content.js).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { paintPopupOpacity } from '../host/popup-bridge.js'
import { opacityCss } from '../host/ext/content.js'

test('Hachidori and 10ten: the shadow host at the opacity, nothing at 100', () => {
  assert.equal(opacityCss(35), ':host { opacity: 0.35 !important; }')
  assert.equal(opacityCss(0), ':host { opacity: 0.1 !important; }')
  for (const value of [100, 140, undefined, '50', Number.NaN]) assert.equal(opacityCss(value), '', String(value))
})

test('Yomitan: the frame at the opacity, inline and important, and given back at 100', () => {
  const style = new Map()
  const frame = {
    tagName: 'IFRAME',
    style: {
      setProperty: (name, value, priority) => style.set(name, `${value} ${priority}`),
      removeProperty: (name) => style.delete(name)
    }
  }
  paintPopupOpacity({ _frame: frame }, 40)
  assert.equal(style.get('opacity'), '0.4 important')
  paintPopupOpacity({ _frame: frame }, 5)
  assert.equal(style.get('opacity'), '0.1 important')
  paintPopupOpacity({ _frame: frame }, 100)
  assert.equal(style.has('opacity'), false)
  paintPopupOpacity({ _frame: frame }, undefined)
  assert.equal(style.has('opacity'), false)
  assert.doesNotThrow(() => paintPopupOpacity(null, 40))
})
