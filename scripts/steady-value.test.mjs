import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transform } from 'esbuild'
import { readFile } from 'node:fs/promises'
const { code } = await transform(
  await readFile(new URL('../frontend/kit/steadyValue.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'esm' }
)
const { steadyStart, steadyProp, steadyTyped } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
)

const type = (state, ...values) => values.reduce(steadyTyped, state)

test('late echoes of typed values never overwrite what the field shows', () => {
  // An IME composing ねこ: each step is saved through an async round trip.
  let s = type(steadyStart(''), 'n', 'ね', 'ねk', 'ねこ')
  for (const echo of ['n', 'ね', 'ねk']) {
    s = steadyProp(s, echo)
    assert.equal(s.shown, 'ねこ')
  }
  s = steadyProp(s, 'ねこ')
  assert.equal(s.shown, 'ねこ')
  assert.deepEqual(s.typed, [])
})

test('a synchronous controlled value follows typing', () => {
  let s = steadyStart('')
  s = steadyProp(type(s, 'a'), 'a')
  s = steadyProp(type(s, 'ab'), 'ab')
  assert.equal(s.shown, 'ab')
  assert.deepEqual(s.typed, [])
})

test('a value that was never typed replaces the text (a reset, another entry)', () => {
  let s = type(steadyStart(''), '猫')
  s = steadyProp(s, '猫')
  s = steadyProp(s, '')
  assert.equal(s.shown, '')
  s = steadyProp(s, '犬')
  assert.equal(s.shown, '犬')
})

test('a value typed twice is matched in order', () => {
  let s = type(steadyStart(''), 'a', 'ab', 'a')
  s = steadyProp(s, 'a')
  assert.equal(s.shown, 'a')
  assert.deepEqual(s.typed, ['ab', 'a'])
  s = steadyProp(s, 'ab')
  assert.equal(s.shown, 'a')
  s = steadyProp(s, 'a')
  assert.equal(s.shown, 'a')
  assert.deepEqual(s.typed, [])
})

test('an unchanged prop leaves the state as it is', () => {
  const s = type(steadyStart('x'), 'xy')
  assert.equal(steadyProp(s, 'x'), s)
})
