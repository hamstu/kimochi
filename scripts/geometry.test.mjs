import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transform } from 'esbuild'
import { readFile } from 'node:fs/promises'
const { code } = await transform(
  await readFile(new URL('../ui/geometry.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'esm' }
)
const { boxes, sourceDisplay, displayAfterLayout } = await import(
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
test('Windows frames map through desktop points like a Retina frame on macOS', () => {
  // Native converts a Windows frame's physical `source_bounds` to desktop points
  // (platform::DesktopGeometry::frame_info_to_desktop): a 900×600 physical window at
  // x=2400 on a 150 % monitor whose raw origin is 1920 sits at 2240 points, 600×400.
  // Frame pixels stay physical, so the mapping is the same per-axis ratio as Retina.
  const info = {
    full_width: 900,
    full_height: 600,
    crop_pixels: [0, 0, 900, 600],
    source_bounds: { x: 2240, y: 200, width: 600, height: 400 }
  }
  const word = {
    description: '言葉',
    boundingPoly: {
      vertices: [
        { x: 90, y: 60 },
        { x: 180, y: 60 },
        { x: 180, y: 90 },
        { x: 90, y: 90 }
      ]
    }
  }
  const overlay = { x: 1920, y: 0, width: 1920, height: 1080 }
  const [box] = boxes(info, [word], overlay)
  assert.equal(box.text, '言葉')
  assert.ok(Math.abs(box.x - 380) < 1e-9 && Math.abs(box.y - 240) < 1e-9, JSON.stringify(box))
  assert.ok(Math.abs(box.width - 60) < 1e-9 && Math.abs(box.height - 20) < 1e-9, JSON.stringify(box))
  // The same window as macOS would report it at 2× gives the same overlay box.
  const [mac] = boxes(
    { ...info, full_width: 1200, full_height: 800, crop_pixels: [0, 0, 1200, 800] },
    [{ ...word, boundingPoly: { vertices: word.boundingPoly.vertices.map((v) => ({ x: (v.x * 4) / 3, y: (v.y * 4) / 3 })) } }],
    overlay
  )
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(mac[key] - box[key]) < 1e-9)
})

test('after a display change the overlay covers the display it was on, as it is now (#42)', () => {

  // One display, its resolution halved: same origin, new size.
  const before = { x: 0, y: 0, width: 3440, height: 1440 }
  const after = [{ x: 0, y: 0, width: 1720, height: 720 }]
  assert.deepEqual(displayAfterLayout(before, after, null), after[0])
  // Two displays: the source's display wins.
  const two = [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 2560, height: 1440 }]
  assert.deepEqual(displayAfterLayout(two[0], two, { x: 2400, y: 200, width: 800, height: 600 }), two[1])
  // A source off every display: where the overlay was.
  assert.deepEqual(displayAfterLayout(two[1], two, { x: 9000, y: 0, width: 10, height: 10 }), two[1])
  // The overlay's display was removed: the first one left.
  assert.deepEqual(displayAfterLayout({ x: 5000, y: 0, width: 100, height: 100 }, two, null), two[0])
  assert.equal(displayAfterLayout(before, [], null), null)
})
