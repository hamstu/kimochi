import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
const { currentLines, annotationsInLines } = await load('current-lines.ts')
const { wordAnnotations } = await load('annotations.ts')
const line = (text, y = 0) => ({ text, box: { x: 0, y, width: 100, height: 20 } })
const word = (description, x, y = 0) => ({
  description,
  boundingPoly: {
    vertices: [
      { x, y },
      { x: x + 20, y },
      { x: x + 20, y: y + 10 },
      { x, y: y + 10 }
    ]
  }
})
test('a changing HUD does not invalidate unchanged dialogue, but a one-character edit does', () => {
  const old = [line('猫が好きです'), line('HP12', 50)]
  assert.deepEqual(currentLines(old, [line('猫が好きです'), line('HP11', 50)], 3), [old[0]])
  assert.deepEqual(currentLines(old, [line('犬が好きです')], 3), [])
  assert.deepEqual(currentLines(old, [], 3), [])
  assert.deepEqual(currentLines(old, [line('猫が好きです', 200)], 3), [])
})
test('partial Google-format annotations preserve the first word and remove changed rows', () => {
  const words = [word('猫', 0), word('好き', 30), word('HP12', 0, 50)]
  const full = {
    description: 'aggregate',
    boundingPoly: {
      vertices: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 }
      ]
    }
  }
  const kept = annotationsInLines([full, ...words], [line('').box])
  assert.deepEqual(
    wordAnnotations(kept).map((a) => a.description),
    ['猫', '好き']
  )
  assert.equal(kept[0].description, '猫 好き')
})
