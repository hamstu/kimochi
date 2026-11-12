/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helpers. */
/**
 * The overlay measures its text as it draws it (#92).
 *
 * Chromium (so Chrome and WebView2) applies `text-spacing-trim` by default: of two adjacent CJK
 * marks (。」, 」「, 、「) one is set in half its cell, in a canvas's `measureText` and in the page
 * alike, though not always the same one. The layout (text-layout.js) places each glyph by its own
 * advance, so measuring whole runs, or letting the page trim what the layout did not, put every
 * glyph after such a pair half a glyph from the word under the pointer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load } from './load.mjs'

// A canvas that measures as Chromium's does: a full em per character, less half an em for each
// pair of adjacent full-width marks.
const MARKS = new Set([...'「」『』、。（）'])
const measureText = (text) => {
  const all = [...text]
  let width = all.length * 100
  for (let i = 1; i < all.length; i++) if (MARKS.has(all[i - 1]) && MARKS.has(all[i])) width -= 50
  return {
    width,
    actualBoundingBoxLeft: -6,
    actualBoundingBoxRight: width - 6,
    actualBoundingBoxAscent: 84,
    actualBoundingBoxDescent: 8,
    fontBoundingBoxAscent: 88,
    fontBoundingBoxDescent: 12
  }
}
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  createElement: () => ({ style: {}, getContext: () => ({ measureText }) })
}
const { measureFor } = await load('render.js')

test('a run is measured as the sum of its characters, adjacent marks untrimmed', () => {
  const measure = measureFor('default')
  assert.equal(measure('。」'), 2)
  assert.equal(measure('う。」マ'), 4)
  assert.equal(measure('う。」マ'), [...'う。」マ'].reduce((sum, c) => sum + measure(c), 0))
  const ink = measure.ink('よ。」')
  assert.equal(ink.advance, 3)
  assert.equal(ink.start, 0.06)
  assert.equal(ink.end, 2.94)
})

test('the overlay draws every mark at its full advance', () => {
  // Without this the page trims what the measure did not.
  const css = readFileSync(new URL('../ui/overlay-text.css', import.meta.url), 'utf8')
  for (const selector of ['.ocr-word', '.ocr-group', '.ocr-run']) {
    const rule = css.match(new RegExp(`\\n\\${selector} \\{([^}]*)\\}`))
    assert.ok(rule, `${selector} has a rule`)
    assert.match(rule[1], /text-spacing-trim: space-all;/, `${selector} turns text-spacing-trim off`)
  }
})
