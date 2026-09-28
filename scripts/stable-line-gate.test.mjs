import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
const { StableLineGate } = await load('stable-line-gate.ts')
const line = (text, y = 0) => ({ text, box: { x: 0, y, width: 100, height: 20 } })
test('covered lines can reorder without new work, but disappearance and return need a fresh request', () => {
  const g = new StableLineGate(),
    a = line('たたかう'),
    b = line('HP12', 50)
  g.cover([a, b])
  assert.equal(g.observe([b, a], 3, 2), false)
  assert.equal(g.observe([a, b], 3, 2), false)
  g.observe([b], 3, 2)
  g.observe([b], 3, 2)
  assert.equal(g.observe([a, b], 3, 2), false)
  assert.equal(g.observe([a, b], 3, 2), true)
})
test('single-character replacements require the configured observation count', () => {
  const g = new StableLineGate(),
    a = line('猫が好きです'),
    b = line('犬が好きです')
  g.cover([a])
  assert.equal(g.observe([b], 3, 3), false)
  assert.equal(g.observe([b], 3, 3), false)
  assert.equal(g.observe([b], 3, 3), true)
})
