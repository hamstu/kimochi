/**
 * The Log's character count (frontend/texthooker/core/charCount.ts): what GameSentenceMiner and
 * exSTATic count, by the same cases as `count_chars` in src-tauri/src/reading_history.rs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const built = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/core/charCount.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node'
})
const { countChars } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)

test('characters are counted as GSM and exSTATic count them, the same as native', () => {
  const cases = [
    ['「わたしは、見守る。」', 7],
    ['ABC abc!', 6],
    ['……', 0],
    ['♪', 0],
    ['！', 0],
    ['～', 0],
    ['ー', 1],
    ['１２３', 3],
    ['・', 0],
    ['〜', 0],
    ['😀', 0],
    ['𠮟る', 2],
    ['○○さん', 2],
    ['行こう\n明日', 5],
    ['ＡＢＣ１２３ abc!', 9]
  ]
  for (const [text, count] of cases) assert.equal(countChars(text), count, text)
})
