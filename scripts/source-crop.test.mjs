import test from 'node:test'
import assert from 'node:assert/strict'
import { URL } from 'node:url'
import { Buffer } from 'node:buffer'
import { build } from 'esbuild'
const { outputFiles } = await build({
  entryPoints: [new URL('../frontend/source-picker/crop.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node'
})
const { cropFromDrag, scaleCrop } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

test('reverse crop drag clamps to source and rounds edges outward', () => {
  assert.deepEqual(cropFromDrag({ x: 100.2, y: 80.8 }, { x: -10, y: 20.2 }, 200, 100), {
    x: 0,
    y: 20,
    width: 101,
    height: 61,
    reference_width: 200,
    reference_height: 100
  })
})
test('saved crop scales both axes to new preview dimensions', () => {
  assert.deepEqual(
    scaleCrop(
      { x: 10, y: 20, width: 50, height: 40, reference_width: 200, reference_height: 100 },
      400,
      300
    ),
    {
      x: 20,
      y: 60,
      width: 100,
      height: 120,
      reference_width: 400,
      reference_height: 300
    }
  )
})
test('click without drag and invalid dimensions do not create an empty crop', () => {
  assert.equal(cropFromDrag({ x: 20, y: 30 }, { x: 20, y: 30 }, 200, 100), null)
  assert.equal(cropFromDrag({ x: 0, y: 0 }, { x: 20, y: 30 }, 0, 100), null)
  assert.equal(cropFromDrag({ x: Number.NaN, y: 0 }, { x: 20, y: 30 }, 200, 100), null)
})
