import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transform } from 'esbuild'
import { readFile } from 'node:fs/promises'
const { code } = await transform(
  await readFile(new URL('../ui/geometry.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'esm' }
)
const { boxes, sourceDisplay } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
)
const a = {
  description: '日本語',
  boundingPoly: {
    vertices: [
      { x: 20, y: 10 },
      { x: 120, y: 10 },
      { x: 120, y: 50 },
      { x: 20, y: 50 }
    ]
  }
}
test('crop origin uses current full capture pixels and independent axes', () => {
  assert.deepEqual(
    boxes(
      {
        full_width: 1280,
        full_height: 1200,
        crop_pixels: [320, 300, 640, 600],
        source_bounds: { x: 1800, y: 100, width: 640, height: 400 }
      },
      [a],
      { x: 1728, y: 0, width: 3440, height: 1440 }
    ),
    [{ x: 242, y: 203.33333333333331, width: 50, height: 13.333333333333332, text: '日本語' }]
  )
})
test('same logical box at 1x and Retina, independent of controller DPR', () => {
  const base = {
      full_width: 640,
      full_height: 400,
      crop_pixels: [0, 0, 640, 400],
      source_bounds: { x: -800, y: 50, width: 640, height: 400 }
    },
    origin = { x: -1000, y: 0, width: 1000, height: 800 }
  const retina = { ...base, full_width: 1280, full_height: 800 }
  const doubled = {
    ...a,
    boundingPoly: { vertices: a.boundingPoly.vertices.map((v) => ({ x: v.x * 2, y: v.y * 2 })) }
  }
  assert.deepEqual(boxes(base, [a], origin), boxes(retina, [doubled], origin))
})
test('omitted zero coordinates retained; long Japanese words not filtered by whole-word medians', () => {
  const out = boxes(
    {
      full_width: 640,
      full_height: 400,
      crop_pixels: [0, 0],
      source_bounds: { x: 0, y: 0, width: 640, height: 400 }
    },
    [
      { description: '日本語を勉強しています', boundingPoly: { vertices: [{}, { x: 200, y: 30 }] } }
    ],
    { x: 0, y: 0, width: 640, height: 400 }
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].x, 0)
})
test('monitor chosen from captured source including negative origins', () => {
  const d = [
    { x: -1000, y: -100, width: 1000, height: 800 },
    { x: 0, y: 0, width: 1728, height: 1117 }
  ]
  assert.deepEqual(sourceDisplay({ x: -900, y: 0, width: 640, height: 400 }, d), d[0])
})
