/**
 * Settings → Anki's Detect for the Yomitan API (frontend/texthooker/lib/ankiDetect.ts): which note
 * type and deck someone mines into, and which fields take which marker, from a stand-in Anki.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-anki-detect-'))
const outfile = path.join(outDir, 'detect.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/lib/ankiDetect.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022'
})
const { detectAnkiSetup, familyMappings, noteFamily, searchName } = await import(pathToFileURL(outfile).href)
test.after(() => rm(outDir, { recursive: true, force: true }))

const LAPIS = ['Expression', 'ExpressionFurigana', 'ExpressionReading', 'ExpressionAudio', 'SelectionText',
  'MainDefinition', 'DefinitionPicture', 'Sentence', 'SentenceFurigana', 'SentenceAudio', 'Picture', 'Glossary',
  'Hint', 'IsWordAndSentenceCard', 'IsClickCard', 'IsSentenceCard', 'PitchPosition', 'PitchCategories',
  'Frequency', 'FreqSort', 'MiscInfo']
const SENREN = ['word', 'reading', 'sentence', 'sentenceFurigana', 'sentenceTranslation', 'picture', 'wordAudio',
  'sentenceAudio', 'selectionText', 'definition', 'glossary', 'pitchAccents', 'frequencies', 'miscInfo']

const asMap = (mappings) => Object.fromEntries(mappings.map((m) => [m.ankiField, m.marker ?? `(${m.mappingType})`]))

const TANGO = ['Expression', 'Reading', 'Meaning', 'Audio']

test('only Lapis, Kiku and Senren count, by a name that starts with the family', () => {
  assert.equal(noteFamily('Lapis'), 'lapis')
  assert.equal(noteFamily('Kiku v2'), 'kiku')
  assert.equal(noteFamily('senren 5.1'), 'senren')
  for (const other of ['My Kiku', 'Kikuchi', 'Tango Card Format', 'Kaishi 1.5k']) assert.equal(noteFamily(other), null, other)
})

test("a family's fields map onto the note type, and without its core fields it is not one", () => {
  assert.deepEqual(asMap(familyMappings('lapis', LAPIS)), {
    Expression: 'expression',
    ExpressionReading: 'reading',
    ExpressionAudio: 'audio',
    MainDefinition: 'glossary',
    Sentence: '(sentence)',
    SentenceFurigana: 'sentence-furigana',
    Frequency: 'frequencies'
  })
  assert.deepEqual(asMap(familyMappings('senren', SENREN)), {
    word: 'expression',
    reading: 'reading',
    sentence: '(sentence)',
    sentenceFurigana: 'sentence-furigana',
    wordAudio: 'audio',
    definition: 'glossary',
    pitchAccents: 'pitch-accents',
    frequencies: 'frequencies'
  })
  assert.equal(familyMappings('lapis', TANGO), null)
})

test('search names take quotes, backslashes and wildcards literally', () => {
  assert.equal(searchName('日本語::Mining_2 "*"'), '日本語::Mining\\_2 \\"\\*\\"')
})

/** A stand-in AnkiConnect: notes as {id, model, deck}, answering the searches Detect makes. */
function anki(models, notes, decks) {
  const queries = []
  const unescape = (s) => s.replace(/\\(.)/g, '$1')
  return {
    queries,
    models: async () => Object.keys(models),
    fields: async (m) => models[m],
    decks: async () => decks,
    findNotes: async (query) => {
      queries.push(query)
      const model = unescape(/"note:((?:\\.|[^"\\])*)"/.exec(query)[1])
      const deck = /"deck:((?:\\.|[^"\\])*)"/.exec(query)?.[1]
      return notes
        .filter((n) => n.model === model && (deck === undefined || n.deck === unescape(deck)) && n.deck !== 'Filtered')
        .map((n) => n.id)
    }
  }
}

const notes = (model, deck, count, from) => Array.from({ length: count }, (_, i) => ({ id: from + i, model, deck }))

test('the mining note type with the most notes wins, in the deck holding most of them', async () => {
  // Like a real collection: a pre-made deck's note type holds more notes than the mining one.
  const reader = anki(
    { 'Tango Card Format': TANGO, Lapis: LAPIS, 'My Kiku': LAPIS, 'Senren v5': SENREN },
    [
      ...notes('Tango Card Format', 'Tango N5', 500, 1),
      ...notes('My Kiku', 'Old', 400, 600),
      ...notes('Lapis', 'Mining', 30, 1000),
      ...notes('Lapis', 'Mining::Old', 10, 2000),
      ...notes('Lapis', 'Filtered', 50, 2500),
      ...notes('Senren v5', 'Default', 12, 3000)
    ],
    ['Default', 'Tango N5', 'Old', 'Mining', 'Mining::Old', 'Filtered']
  )
  const found = await detectAnkiSetup(reader)
  assert.equal(found.ok, true)
  assert.equal(found.modelName, 'Lapis')
  assert.equal(found.deckName, 'Mining')
  assert.equal(found.deckNotes, 30, 'subdecks and filtered decks count on their own')
  assert.ok(reader.queries.includes('"note:Lapis" "deck:Mining" -"deck:Mining::*" -deck:filtered'))
})

test('nothing to suggest, or a tie, says why', async () => {
  const none = await detectAnkiSetup(anki({ 'Tango Card Format': TANGO }, notes('Tango Card Format', 'Default', 5, 1), ['Default']))
  assert.equal(none.ok, false)
  assert.match(none.reason, /No Lapis, Kiku or Senren/)
  const empty = await detectAnkiSetup(anki({ Lapis: LAPIS }, [], ['Default']))
  assert.match(empty.reason, /Lapis note type has no notes yet/)
  const tied = await detectAnkiSetup(anki({ Lapis: LAPIS }, [...notes('Lapis', 'A', 3, 1), ...notes('Lapis', 'B', 3, 10)], ['A', 'B']))
  assert.match(tied.reason, /Two decks have the most Lapis notes/)
})
