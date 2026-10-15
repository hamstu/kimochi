import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transform } from 'esbuild'
import { readFile } from 'node:fs/promises'
const { code } = await transform(await readFile(new URL('../ui/scan-text.ts', import.meta.url), 'utf8'), {
  loader: 'ts',
  format: 'esm'
})
const { wordAtStart } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

// The shape of the Yomitan API's /tokenize answer: chunks of groups, each group's first entry the
// anchor Yomitan matched, with the inflected spans it matched in its headwords' sources.
const parse = (...entries) => [{ content: entries.map((entry) => [entry]) }]

test('the word at the start of the window, widened to its inflected form', () => {
  const chunks = parse(
    { text: '書き', headwords: [[{ sources: [{ originalText: '書き込み' }] }]] },
    { text: 'を' }
  )
  assert.equal(wordAtStart(chunks, '書き込みを見た'), '書き込み')
})

test('a widened span that is not literally in the text is not used', () => {
  const chunks = parse({ text: '覚え', headwords: [[{ sources: [{ originalText: '覚える' }] }]] })
  assert.equal(wordAtStart(chunks, '覚えろ'), '覚え')
})

test('no word when the first anchor is not at the start', () => {
  assert.equal(wordAtStart(parse({ text: '猫' }), '「猫」'), null)
})

test('nothing parsed, nothing found', () => {
  assert.equal(wordAtStart([], '猫'), null)
  assert.equal(wordAtStart(null, '猫'), null)
})
