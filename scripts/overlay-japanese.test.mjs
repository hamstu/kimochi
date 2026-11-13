/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helpers. */
/**
 * Japanese keeps its layout and its lookups while, in a language that spaces its words, words are
 * drawn and lines joined for a whole-word lookup (text-layout.js `wholeWords`, render.js
 * `appendRuns`).
 *
 * Every Japanese answer in the alignment corpus (every engine: dialogue in 「」, HUD lines mixing
 * Latin and digits, full-width ＨＰ, ellipses, manga, vertical text) and hand-made lines mixing
 * Japanese with English and punctuation (overlay-cases.mjs) are drawn in word and grouped mode: no
 * Japanese glyph moves together with another, and no line is joined to the next with a space, even
 * where Latin text breaks across them ("最新のRPG" | "Gameです。").
 *
 * A few are held to exactly how `main` drew them, before words set with spaces were handled
 * (scripts/fixtures/overlay-japanese/main-cases.json): each box's render key (its fitted runs,
 * with their offsets and squeezed marks) and its text, plain or moved (`[glyph, margin-left,
 * margin-right]`), recorded from `main`'s renderer at the commit the file names, with these cases.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load } from './load.mjs'
import { installFakeDom, japaneseCases, draw } from './overlay-cases.mjs'

installFakeDom()
const modules = { ...(await load('render.js')), ...(await load('ocr-result.ts')) }
const { wholeWords } = await load('text-layout.js')
const cases = japaneseCases()
const MAIN = JSON.parse(
  readFileSync(new URL('./fixtures/overlay-japanese/main-cases.json', import.meta.url), 'utf8')
).cases

/** Kana, kanji, Japanese marks and full-width forms. */
const JAPANESE = /[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}\u3000-\u303f\uff00-\uffef]/u
/** Every element under `node`, in order. */
const elements = (node) => (node.tag === 'text' ? [] : [node, ...node.children.flatMap(elements)])

/** A box's text as `MAIN` holds it: plain text, and each moved glyph with its margins. */
const px = (value) => (value ? String(Math.round(parseFloat(value) * 100) / 100) : '')
function drawnText(node) {
  if (node.tag === 'text') return [node.textContent]
  if (node.className === 'ocr-glyph') return [[node.textContent, px(node.style.marginLeft), px(node.style.marginRight)]]
  if (node.className === 'ocr-lookahead') return []
  if (node.children.length) return node.children.flatMap(drawnText)
  return node.textContent ? [node.textContent] : []
}

test('the corpus has every engine, and the hand-made lines are here', () => {
  for (const engine of ['googlelens', 'cloud', 'meikiocr', 'mangaocr', 'livetext', 'oneocr-shape'])
    assert.ok(
      cases.some((c) => c.name.endsWith(`.${engine}`)),
      `no ${engine} answer`
    )
  assert.ok(cases.length >= 80)
  for (const name of Object.keys(MAIN))
    assert.ok(
      cases.some((c) => c.name === name),
      `no case "${name}"`
    )
})

for (const grouped of [false, true]) {
  test(`${grouped ? 'grouped' : 'word'} mode: Japanese glyphs move alone, and no line gets a joiner`, () => {
    let moved = 0
    for (const c of cases) {
      const { host, renderer } = draw(modules, c, grouped)
      for (const element of elements(host)) {
        assert.notEqual(element.className, 'ocr-joiner', `${c.name}: a space was added between its lines`)
        if (element.className === 'ocr-glyph') {
          moved++
          const glyphs = [...element.textContent]
          if (JAPANESE.test(element.textContent))
            assert.equal(glyphs.length, 1, `${c.name}: "${element.textContent}" moved as one`)
        }
      }
      if (!grouped && c.name in MAIN) {
        const drawn = host.children.map((box) => ({ key: JSON.parse(box.renderKey), text: drawnText(box) }))
        assert.deepEqual(drawn, MAIN[c.name], `${c.name} is not drawn as main drew it`)
      }
      renderer.destroy()
    }
    assert.ok(moved > 100, `only ${moved} moved glyphs: the cases test too little`)
  })
}

test('Japanese has no whole words, whatever Latin, digits or spaces are in a line', () => {
  const lines = cases.flatMap((c) => c.annotations.flatMap((a) => (a.description ?? '').split('\n')))
  const japanese = lines.filter((line) => JAPANESE.test(line))
  assert.ok(japanese.length > 100)
  const measure = modules.measureFor('default', 'ja')
  for (const line of japanese) assert.deepEqual(wholeWords(line, measure), [], line)
  // Latin text read with Japanese chosen is set as it always was, too.
  assert.deepEqual(wholeWords('Completa encargos', measure), [])
})
