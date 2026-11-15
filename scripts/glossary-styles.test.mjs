/**
 * The pop-up's shared dictionary stylesheets (frontend/texthooker/lib/glossaryStyles.ts): every
 * entry's glossary without its `<style>` copies, and each distinct stylesheet once.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-glossary-styles-'))
const outfile = path.join(outDir, 'glossary-styles.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/lib/glossaryStyles.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022'
})
const { shareGlossaryStyles } = await import(pathToFileURL(outfile).href)
test.after(() => rm(outDir, { recursive: true, force: true }))

// The shape Yomitan's glossary marker gives: a dictionary's sheet after each of its definitions.
const jmdict =
  '.yomitan-glossary {[data-dictionary="JMdict"] {[data-sc-content="glossary"] {list-style-type: circle;}}}'
const daijisen = '.yomitan-glossary {[data-dictionary="大辞泉"] {[data-sc-class="tag"] {font-weight: bold;}}}'
const entry = (sheets) =>
  `<div class="yomitan-glossary"><ol>${sheets
    .map((css, i) => `<li data-dictionary="d${i}"><span>meaning ${i}</span></li><style>${css}</style>`)
    .join('')}</ol></div>`

test('every entry loses its stylesheet copies; each distinct sheet is kept once, in order', () => {
  const { glossaries, css } = shareGlossaryStyles([
    entry([jmdict, daijisen]),
    entry([jmdict]),
    entry([daijisen, jmdict])
  ])
  assert.equal(css, `${jmdict}\n${daijisen}`)
  for (const g of glossaries) assert.doesNotMatch(g, /<style/i)
  assert.equal(
    glossaries[1],
    '<div class="yomitan-glossary"><ol><li data-dictionary="d0"><span>meaning 0</span></li></ol></div>'
  )
})

test('glossaries without stylesheets pass through unchanged', () => {
  const plain = '<div class="yomitan-glossary"><ol><li>to see</li></ol></div>'
  assert.deepEqual(shareGlossaryStyles([plain, '']), {
    glossaries: [plain, ''],
    css: ''
  })
})

test('a style element with attributes or odd case is still one of them', () => {
  const { glossaries, css } = shareGlossaryStyles([`<p>a</p><STYLE type="text/css">${jmdict}</STYLE >`])
  assert.equal(glossaries[0], '<p>a</p>')
  assert.equal(css, jmdict)
})
