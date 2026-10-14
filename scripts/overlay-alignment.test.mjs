/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helpers. */
/**
 * The overlay's text lines up with the source text it was read from, for every OCR engine.
 *
 * The fixtures (scripts/fixtures/overlay-alignment/; where they come from is in the header of
 * scripts/measure-overlay-alignment.mjs) are real answers from each engine for game-style images
 * whose true glyph positions are known. This lays each answer out
 * exactly as word mode does (`wordLayout` in render.js, through `mapAnnotations` and the engine's
 * ink margins), in the overlay font's own recorded metrics (glyphs.json), puts each glyph where
 * CSS would, and scores it against the truth with the same metrics the headless measurement uses
 * (scripts/measure-overlay-alignment.mjs, which also renders it in Chrome). No browser, no network.
 *
 * Errors are in glyphs: 0.1 is a tenth of a character out. The thresholds hold what the fit
 * achieves today with some room; the word-mode renderer it replaced (a font 0.7 × the box height,
 * letter spacing clamped to ±2 px, a 1.2× zoom on hover) was 0.15 (cloud) to 0.8 (MeikiOCR) of a
 * glyph out on average along the line on the same fixtures.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { load } from './load.mjs'
import { alignmentMetrics, summarize } from './overlay-alignment-metrics.mjs'

const FIXTURES = fileURLToPath(new URL('./fixtures/overlay-alignment/', import.meta.url))
const { wordLayout } = await load('render.js')
const { mapAnnotations } = await load('geometry.ts')
const { visibleAnnotations, DEFAULT_GROUPING } = await load('annotations.ts')
const { withInkMargins } = await load('ocr-result.ts')

/** The overlay font, from the metrics recorded in it: per character, as it draws (no kerning). */
const recorded = JSON.parse(readFileSync(path.join(FIXTURES, 'glyphs.json'), 'utf8'))
const fallback = (c) => (/[ -ɏ｡-ﾟ]/u.test(c) ? [0.56, 0.04, 0.52, 0.7, 0] : [1, 0.06, 0.94, 0.84, 0.08])
const glyph = (c) => (c in recorded.glyphs ? recorded.glyphs[c] : fallback(c))
const advance = (c) => (glyph(c) ?? fallback(c))[0]
function measure(text) {
  let ems = 0
  for (const c of text) ems += advance(c)
  return ems
}
measure.ink = (text) => {
  let at = 0
  let ink = null
  for (const c of text) {
    const g = glyph(c)
    if (g) {
      const [, start, end, ascent, descent] = g
      ink = ink
        ? {
            ...ink,
            start: Math.min(ink.start, at + start),
            end: Math.max(ink.end, at + end),
            ascent: Math.max(ink.ascent, ascent),
            descent: Math.max(ink.descent, descent)
          }
        : { start: at + start, end: at + end, ascent, descent }
    }
    at += advance(c)
  }
  return ink && { ...ink, advance: at, ...recorded.font }
}

/** Where CSS puts each glyph of a fitted run (overlay.html: line box, letter spacing, offsets). */
function drawn(run) {
  const out = []
  const f = run.fontSize
  let before = 0
  ;[...run.text].forEach((c, i) => {
    const origin = (run.vertical ? run.rect.y : run.rect.x) + run.lead + f * before + run.spacing * i
    before += advance(c)
    if (!c.trim()) return
    if (run.vertical) {
      out.push({ c, cx: run.rect.x + run.rect.width / 2 + run.shift, cy: origin + (f * advance(c)) / 2, ink: null, fontSize: f })
      return
    }
    const { fontAscent: a, fontDescent: d } = recorded.font
    const baseline = run.rect.y + run.shift + (run.rect.height - (a + d) * f) / 2 + a * f
    const [, start, end, ascent, descent] = glyph(c) ?? fallback(c)
    const ink = [origin + start * f, baseline - ascent * f, origin + end * f, baseline + descent * f]
    out.push({ c, cx: (ink[0] + ink[2]) / 2, cy: (ink[1] + ink[3]) / 2, ink, fontSize: f })
  })
  return out
}

/** Every fixture with its truth: `<sample>.<engine>.json` beside `<sample>.truth.json`. */
const fixtures = readdirSync(FIXTURES)
  .map((file) => file.match(/^([\w-]+)\.([\w-]+)\.json$/))
  .filter((match) => match && match[2] !== 'truth')
  .filter(([, sample]) => existsSync(path.join(FIXTURES, `${sample}.truth.json`)))
  .map(([file, sample, engine]) => ({
    sample,
    engine,
    truth: JSON.parse(readFileSync(path.join(FIXTURES, `${sample}.truth.json`), 'utf8')),
    ocr: JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8'))
  }))

/** Word mode's layout of one fixture, as overlay.js hands it over at its capture scale. */
function layout(fixture) {
  const scale = fixture.truth.scale ?? 1
  const { width, height } = fixture.truth
  const bounds = { x: 0, y: 0, width: width / scale, height: height / scale }
  const info = { full_width: width, full_height: height, crop_pixels: [0, 0, width, height], source_bounds: bounds }
  const annotations = visibleAnnotations(withInkMargins(fixture.ocr.textAnnotations, fixture.ocr.engine), DEFAULT_GROUPING)
  const mapped = mapAnnotations(info, annotations, bounds)
  return { mapped, runs: wordLayout(mapped, measure).flat(), scale }
}

const scored = fixtures
  .filter((fixture) => fixture.truth.lines.length)
  .map((fixture) => {
    const { runs, scale } = layout(fixture)
    return { sample: fixture.sample, engine: fixture.engine, mode: 'words', ...alignmentMetrics(fixture.truth, runs.flatMap(drawn), scale) }
  })

test('the corpus covers every engine', () => {
  const engines = new Set(fixtures.map((fixture) => fixture.engine))
  for (const engine of ['googlelens', 'cloud', 'meikiocr', 'mangaocr', 'livetext', 'oneocr-shape'])
    assert.ok(engines.has(engine), `no fixture for ${engine}`)
})

/**
 * Per engine, glyph-weighted over its samples: mean and 90th-percentile error along the line,
 * mean error across it, and the drawn size against the true one. Samples where the engine misread
 * most of the text (fewer than 60% of the glyphs matched) cannot be scored and are left out.
 */
const LIMITS = {
  cloud: { along: 0.06, p90: 0.12, across: 0.08 },
  googlelens: { along: 0.08, p90: 0.16, across: 0.06 },
  meikiocr: { along: 0.08, p90: 0.16, across: 0.06 },
  'oneocr-shape': { along: 0.06, p90: 0.1, across: 0.06 },
  livetext: { along: 0.2, p90: 0.42, across: 0.1 },
  // Where its detector's line regions are clean. Its manga samples are held below.
  mangaocr: { along: 0.06, p90: 0.12, across: 0.06, samples: ['large'] }
}

for (const [engine, limit] of Object.entries(LIMITS)) {
  test(`${engine}: each glyph is drawn over the one it was read from`, () => {
    const rows = scored.filter(
      (row) => row.engine === engine && row.coverage >= 0.6 && (!limit.samples || limit.samples.includes(row.sample))
    )
    assert.ok(rows.length, 'scored on at least one sample')
    const [summary] = summarize(rows)
    const detail = rows.map((row) => `${row.sample} ${row.alongMean.toFixed(3)}`).join(', ')
    assert.ok(summary.alongMean <= limit.along, `mean along ${summary.alongMean.toFixed(3)} (${detail})`)
    assert.ok(summary.alongP90 <= limit.p90, `p90 along ${summary.alongP90.toFixed(3)}`)
    assert.ok(summary.acrossMean <= limit.across, `mean across ${summary.acrossMean.toFixed(3)}`)
    assert.ok(Math.abs(summary.sizeRatio - 1) <= 0.15, `size ratio ${summary.sizeRatio.toFixed(3)}`)
  })
}

test('every line is set at one size', () => {
  for (const row of scored)
    assert.ok(row.sizeSpread <= 0.02, `${row.sample}.${row.engine}: sizes on one line vary ${(row.sizeSpread * 100).toFixed(1)}%`)
})

test('a line read without word boxes still spans its box: single-line engines', () => {
  // Live Text and OneOCR answer a line per box; every glyph of the line still lands within a
  // third of a glyph of where it is, start to end.
  for (const row of scored.filter((r) => ['livetext', 'oneocr-shape'].includes(r.engine) && r.sample !== 'pixel'))
    assert.ok(row.alongP90 <= 0.6, `${row.sample}.${row.engine}: p90 ${row.alongP90.toFixed(3)}`)
})

test('every box, from every engine, is laid out inside itself with finite numbers', () => {
  for (const fixture of fixtures) {
    const { mapped, runs } = layout(fixture)
    assert.ok(runs.length >= mapped.length, `${fixture.sample}.${fixture.engine}: a box drew nothing`)
    for (const run of runs) {
      for (const key of ['fontSize', 'spacing', 'lead', 'shift'])
        assert.ok(Number.isFinite(run[key]), `${fixture.sample}.${fixture.engine}: ${key} of ${run.text}`)
      const along = run.vertical ? run.rect.height : run.rect.width
      // The ink runs from the box's start to its end: no glyph is drawn far outside it.
      for (const g of drawn(run)) {
        const at = (run.vertical ? g.cy - run.rect.y : g.cx - run.rect.x) / run.fontSize
        assert.ok(at > -0.75 && at < along / run.fontSize + 0.75, `${fixture.sample}.${fixture.engine}: ${g.c} of ${run.text} at ${at.toFixed(2)}`)
      }
    }
  }
})

/**
 * Manga OCR's detector reports line regions, not lines: in `bubble` (a real Quick Shot of one
 * speech bubble, two blocks of two columns with ruby beside every column) a ruby column, one
 * column in three pieces, and two columns and their ruby run together; in `vertical` two of three
 * columns. Shared out over those as lines, the text was set at three sizes from 11 to 63 px in
 * one bubble and drawn over the ruby. It is set as columns, a bubble at one size, over its text.
 */
test('Manga OCR: a speech bubble is lettered as columns at one size, over its own text', () => {
  const fixture = fixtures.find((f) => f.sample === 'bubble' && f.engine === 'mangaocr')
  const { mapped, runs } = layout(fixture)
  const size = fixture.truth.lines[0].size
  assert.ok(runs.every((run) => run.vertical), 'every run is a column')
  // The first block's regions are good enough to find its two columns, and the break between them.
  assert.deepEqual(runs.slice(0, 2).map((run) => run.text), ['遥太郎くんの', '偏差値は３５。'])
  // One size per block; the bubble's two blocks within a quarter of each other and of the truth.
  const blockSizes = wordLayout(mapped, measure).map((block, index) => {
    const own = block.map((run) => run.fontSize)
    assert.ok(Math.max(...own) - Math.min(...own) < 0.01, `block ${index}: sizes ${own.map((s) => s.toFixed(1))}`)
    return own[0]
  })
  assert.ok(Math.max(...blockSizes) / Math.min(...blockSizes) <= 1.25, `block sizes ${blockSizes.map((s) => s.toFixed(1))}`)
  for (const s of blockSizes) assert.ok(s / size >= 0.85 && s / size <= 1.15, `size ${s.toFixed(1)} against ${size}`)
  // Every glyph is drawn over the bubble's text, none out past it.
  const truth = fixture.truth.lines.flatMap((line) => line.glyphs)
  const [x0, y0] = [Math.min(...truth.map((g) => g.x)), Math.min(...truth.map((g) => g.y))]
  const [x1, y1] = [Math.max(...truth.map((g) => g.x + g.w)), Math.max(...truth.map((g) => g.y + g.h))]
  for (const g of runs.flatMap(drawn))
    assert.ok(g.cx > x0 - size / 2 && g.cx < x1 + size / 2 && g.cy > y0 - size / 2 && g.cy < y1 + size / 2, `${g.c} at ${g.cx.toFixed(0)},${g.cy.toFixed(0)}`)
  for (const [sample, along] of [['bubble', 0.8], ['vertical', 0.3]]) {
    const row = scored.find((r) => r.sample === sample && r.engine === 'mangaocr')
    assert.ok(row.coverage >= 0.6, `${sample}: coverage ${row.coverage.toFixed(2)}`)
    assert.ok(row.alongMean <= along, `${sample}: mean along ${row.alongMean.toFixed(3)}`)
    assert.ok(row.sizeSpread <= 0.02, `${sample}: sizes on one column vary ${(row.sizeSpread * 100).toFixed(1)}%`)
  }
})
