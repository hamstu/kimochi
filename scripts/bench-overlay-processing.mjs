/**
 * CPU-only overlay processing benchmark. Run with `node scripts/bench-overlay-processing.mjs`.
 * Measures geometry and OCR normalization, not capture, OCR engines, DOM layout, or app latency.
 * Inputs are prepared outside timed regions; each sample reports ms per complete input batch.
 * There are no timing assertions: compare several runs on the same machine when changing these
 * paths. `--modules <directory>` can load previously bundled annotations.mjs / ocr-result.mjs.
 */
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { load } from './load.mjs'

const modulesAt = process.argv.indexOf('--modules')
const modules = modulesAt < 0 ? null : process.argv[modulesAt + 1]
if (modulesAt >= 0 && !modules) throw Error('--modules needs a directory')
const moduleOf = (entry) =>
  modules ? import(pathToFileURL(path.resolve(modules, entry.replace(/\.ts$/, '.mjs')))) : load(entry)
const { getBoundingBox } = await moduleOf('annotations.ts')
const { normalizeOcrResult, logicalGroups } = await moduleOf('ocr-result.ts')

const annotation = (description, x, y, width, height, extra = {}) => ({
  description,
  boundingPoly: {
    vertices: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ]
  },
  ...extra
})

/** OneOCR's shape: one group per line and words associated by group id. */
function oneOcr(lines) {
  const groups = []
  const textAnnotations = []
  for (let line = 0; line < lines; line++) {
    const id = `line-${line}`
    const y = line * 32
    groups.push({
      id,
      text: '今日はいい天気ですね',
      bbox: [0, y, 240, y + 24],
      orientation: 'horizontal',
      linePolygons: [
        [
          [0, y],
          [240, y],
          [240, y + 24],
          [0, y + 24]
        ]
      ]
    })
    for (const [index, text] of ['今日', 'は', 'いい', '天気', 'です', 'ね'].entries()) {
      textAnnotations.push(
        annotation(text, index * 40, y, 36, 24, { groupId: id, granularity: 'fragment', orientation: 'horizontal' })
      )
    }
  }
  return { groups, textAnnotations }
}

const cases = []
const boxes = Array.from({ length: 2048 }, (_, i) =>
  annotation('猫', (i % 40) * 28 - 100, Math.floor(i / 40) * 24, 23, 20)
)
cases.push([
  'bounds/2048-quads',
  400,
  () => {
    let sum = 0
    for (const a of boxes) sum += getBoundingBox(a).centerX
    return sum
  }
])
for (const count of [8, 80, 320]) {
  const input = oneOcr(count)
  cases.push([
    `normalize/${count}-lines/${count * 6}-fragments`,
    count === 320 ? 20 : 100,
    () => {
      const result = normalizeOcrResult(input, 'oneocr')
      return result.textAnnotations.length + result.fullText.length
    }
  ])
  cases.push([
    `group/${count * 6}-assigned-fragments`,
    count === 320 ? 10 : 50,
    () => {
      const result = logicalGroups(input.textAnnotations)
      return result.groups.length + result.annotations.length
    }
  ])
}

let checksum = 0
const results = []
for (const [name, iterations, run] of cases) {
  const batch = () => {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) checksum += run()
    return (performance.now() - start) / iterations
  }
  for (let i = 0; i < 3; i++) batch()
  const samples = Array.from({ length: 9 }, batch).sort((a, b) => a - b)
  results.push({ name, iterations, medianMs: samples[4], minMs: samples[0], maxMs: samples[8] })
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      modules: modules ?? 'working tree',
      warmupBatches: 3,
      samples: 9,
      results,
      checksum
    },
    null,
    2
  )
)
