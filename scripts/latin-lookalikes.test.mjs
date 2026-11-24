import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
const { restoreLatinLookalikes, writtenOnlyInLatin } = await load('latin-lookalikes.ts')
const { normalizeOcrResult } = await load('ocr-result.ts')

// Screen AI's misreads, as recorded: a Cyrillic а (U+0430) for the Latin a.
const CYRILLIC_A = 'а'

test('a Latin word with a Cyrillic or Greek lookalike in it gets its Latin letter back', () => {
  assert.equal(restoreLatinLookalikes(`estrell${CYRILLIC_A}`), 'estrella')
  assert.equal(
    restoreLatinLookalikes(`Consigue la categoría estrell${CYRILLIC_A} de rubí`),
    'Consigue la categoría estrella de rubí'
  )
  assert.equal(restoreLatinLookalikes('cebollа'), 'cebolla')
  // Capitals, Greek too, and a word that is nothing but lookalikes (the Spanish `a`, `o`, `y`).
  assert.equal(restoreLatinLookalikes('Ρеrо'), 'Pero')
  assert.equal(restoreLatinLookalikes('Οk'), 'Ok')
  assert.equal(restoreLatinLookalikes(`voy ${CYRILLIC_A} casa`), 'voy a casa')
  // Accents stay where they are, precomposed or as marks of their own.
  assert.equal(restoreLatinLookalikes('сafé'), 'café')
  assert.equal(restoreLatinLookalikes('аé'), 'aé')
})

test('real Cyrillic and Greek words are left alone, and so is text with no lookalikes', () => {
  // A word with any other Cyrillic or Greek letter is that alphabet's, lookalikes and all.
  assert.equal(restoreLatinLookalikes('Привет, amigo'), 'Привет, amigo')
  assert.equal(restoreLatinLookalikes('Москва'), 'Москва')
  assert.equal(restoreLatinLookalikes('λόγος'), 'λόγος')
  const plain = 'Consigue la categoría estrella de rubí'
  assert.equal(restoreLatinLookalikes(plain), plain)
  assert.equal(restoreLatinLookalikes(''), '')
})

test('the length never changes, so every box and offset measured on the text still holds', () => {
  for (const text of ['estrellа', 'Ρеrо y Οk', 'сafé аé']) {
    assert.equal(restoreLatinLookalikes(text).length, text.length)
  }
})

test('only languages written in the Latin alphabet alone are fixed', () => {
  for (const code of ['es', 'en', 'fr', 'de', 'pt', 'pl', 'tr', 'vi'])
    assert.equal(writtenOnlyInLatin(code), true, code)
  // Russian and Greek are their own; Serbo-Croatian is written in both alphabets; Japanese (the
  // default for no language) has nothing to fix.
  for (const code of ['ru', 'el', 'sh', 'ja', undefined]) assert.equal(writtenOnlyInLatin(code), false, String(code))
})

test('an OCR result read in Spanish comes out with its lookalikes put back everywhere', () => {
  const box = {
    vertices: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 20 },
      { x: 0, y: 20 }
    ]
  }
  const raw = {
    engine: 'screenai',
    fullText: 'categoría estrellа\nde rubí',
    groups: [
      {
        id: 'g',
        text: 'categoría estrellа\nde rubí',
        bbox: [0, 0, 100, 40],
        orientation: 'horizontal',
        lines: ['categoría estrellа', 'de rubí'],
        lineSegments: [[{ text: 'estrellа', bbox: [50, 0, 100, 20] }]]
      }
    ],
    textAnnotations: [{ description: 'estrellа', granularity: 'fragment', groupId: 'g', boundingPoly: box }]
  }
  const result = normalizeOcrResult(raw, 'screenai', 'es')
  assert.equal(result.fullText, 'categoría estrella\nde rubí')
  assert.equal(result.groups[0].text, 'categoría estrella\nde rubí')
  assert.deepEqual(result.groups[0].lines, ['categoría estrella', 'de rubí'])
  assert.equal(result.groups[0].lineSegments[0][0].text, 'estrella')
  assert.ok(!JSON.stringify(result).includes(CYRILLIC_A))
  // The engine's own result is not changed in place.
  assert.equal(raw.groups[0].text, 'categoría estrellа\nde rubí')
  // Read as Russian, the same text is left as the engine gave it.
  assert.ok(normalizeOcrResult(raw, 'screenai', 'ru').fullText.includes(CYRILLIC_A))
})
