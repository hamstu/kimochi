import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { radioTarget } = await load('radio-navigation.ts')

test('radio arrows wrap, Home/End select edges, and Tab/Space retain native behavior', () => {
  assert.equal(radioTarget('ArrowRight', 2, 3), 0)
  assert.equal(radioTarget('ArrowDown', 0, 3), 1)
  assert.equal(radioTarget('ArrowLeft', 0, 3), 2)
  assert.equal(radioTarget('ArrowUp', 1, 3), 0)
  assert.equal(radioTarget('Home', 2, 3), 0)
  assert.equal(radioTarget('End', 0, 3), 2)
  assert.equal(radioTarget('Tab', 0, 3), null)
  assert.equal(radioTarget(' ', 0, 3), null)
  assert.equal(radioTarget('Home', 0, 0), null)
})
