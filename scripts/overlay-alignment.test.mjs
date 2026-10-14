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
  mangaocr: { along: 0.06, p90: 0.12, across: 0.06 }
}

for (const [engine, limit] of Object.entries(LIMITS)) {
  test(`${engine}: each glyph is drawn over the one it was read from`, () => {
    const rows = scored.filter((row) => row.engine === engine && row.coverage >= 0.6)
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
