/**
 * The Yomitan API pop-up's cards (frontend/texthooker/lib/ankiconnect.ts `sendCardForTerm`) name
 * each media file as it was stored. Manatan SRS's AnkiConnect converts every file and names it
 * after its content (`a.mp3` is stored as `mtn_<hash>.webm`), so a field naming the file that was
 * sent showed nothing there (#286). The native side's own media (sentence audio, the screenshot)
 * is tested in Rust (reader::ankiconnect `store_media`).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const mocks = {
  '@tauri-apps/api/core': 'export const invoke = (...args) => backend.invoke(...args);',
  './sentenceAudio': 'export const attachSentenceAudio = (...args) => backend.attached.push(["audio", ...args]);',
  './screenshots': 'export const attachScreenshot = (...args) => backend.attached.push(["screenshot", ...args]);'
}
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/lib/ankiconnect.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  plugins: [
    {
      name: 'anki-transport',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          args.path in mocks ? { path: args.path, namespace: 'mock' } : null
        )
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents: `const backend = new Proxy({}, { get: (_, key) => globalThis.__ankiMediaNames[key] }); ${mocks[args.path]}`
        }))
      }
    }
  ]
})
const anki = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

/** A stand-in AnkiConnect; `rename` gives the name a sent file is stored under. */
function backend(rename) {
  const state = {
    stored: [],
    added: null,
    attached: [],
    invoke: async (command, args) => {
      if (command === 'anki_store_media_file') {
        state.stored.push(args.filename)
        return rename(args.filename)
      }
      if (command === 'anki_add_note') {
        state.added = args
        return 1234
      }
      throw new Error(`unexpected ${command}`)
    }
  }
  globalThis.__ankiMediaNames = state
  return state
}

const AUDIO = 'yomitan_audio_猫_ねこ_0a1b2c.mp3'
const PICTURE = 'yomitan_dictionary_media_1_3f4e.png'
const card = () => ({
  ankiUrl: 'http://127.0.0.1:8765',
  deck: 'Mining',
  model: 'Manatan-NoteType',
  modelFields: ['Expression', 'ExpressionAudio', 'MainDefinition', 'Sentence', 'SentenceAudio', 'Picture'],
  mappings: [
    { ankiField: 'Expression', mappingType: 'marker', marker: 'expression' },
    { ankiField: 'ExpressionAudio', mappingType: 'marker', marker: 'audio' },
    { ankiField: 'MainDefinition', mappingType: 'marker', marker: 'glossary' },
    { ankiField: 'Sentence', mappingType: 'sentence' },
    { ankiField: 'SentenceAudio', mappingType: 'sentenceAudio' }
  ],
  tags: [],
  yomitan: {
    fields: {
      expression: '猫',
      reading: 'ねこ',
      audio: `[sound:${AUDIO}]`,
      glossary: `<div>cat <img src="${PICTURE}"> (${PICTURE})</div>`
    },
    audioMedia: [{ ankiFilename: AUDIO, contentBase64: 'AAAA' }],
    dictionaryMedia: [{ ankiFilename: PICTURE, contentBase64: 'BBBB' }]
  },
  sentence: '猫が好きです。'
})

test('a file Manatan SRS renamed is named in the fields as it was stored', async () => {
  const manatan = { [AUDIO]: 'mtn_0123abcd.webm', [PICTURE]: 'mtn_4567ef01.avif' }
  const state = backend((name) => manatan[name])
  const result = await anki.sendCardForTerm(card())
  assert.deepEqual(result, { noteId: 1234, duplicate: false })
  assert.deepEqual(state.stored, [AUDIO, PICTURE])
  const fields = state.added.fields
  assert.equal(fields.ExpressionAudio, '[sound:mtn_0123abcd.webm]')
  assert.equal(fields.MainDefinition, '<div>cat <img src="mtn_4567ef01.avif"> (mtn_4567ef01.avif)</div>')
  assert.equal(fields.Sentence, '猫が好きです。')
  assert.equal(fields.SentenceAudio, '', 'sentence audio follows once the card is added')
  assert.ok(!JSON.stringify(fields).includes(AUDIO))
  // The card's own sentence audio and screenshot are asked for after the card is added.
  assert.deepEqual(
    state.attached.map((a) => [a[0], a[2]]),
    [
      ['audio', 1234],
      ['screenshot', 1234]
    ]
  )
})

test('Anki keeps the names, and the fields are left as Yomitan wrote them', async () => {
  const state = backend((name) => name)
  await anki.sendCardForTerm(card())
  assert.equal(state.added.fields.ExpressionAudio, `[sound:${AUDIO}]`)
  assert.equal(state.added.fields.MainDefinition, `<div>cat <img src="${PICTURE}"> (${PICTURE})</div>`)
})

test('the renaming touches only the files that were renamed, in every marker', () => {
  const markers = { audio: '[sound:a.mp3]', glossary: '<img src="b.png">', expression: '猫' }
  const renamed = new Map([
    ['a.mp3', 'mtn_1.webm'],
    ['b.png', 'b.png']
  ])
  assert.deepEqual(anki.withStoredMediaNames(markers, renamed), {
    audio: '[sound:mtn_1.webm]',
    glossary: '<img src="b.png">',
    expression: '猫'
  })
  assert.equal(anki.withStoredMediaNames(markers, new Map()), markers)
})
