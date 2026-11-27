/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * What the pinned Hachidori asks of AnkiConnect when a card carries media, which is what
 * `anki_connect_relay` answers for (src-tauri/src/reader/relay_media.rs): it requires
 * `storeMediaFile` to answer the name it sent, and refuses the card otherwise. Manatan SRS
 * answers another name for every file, so the relay keeps Hachidori's names towards Hachidori and
 * the stored ones towards the server. Runs Hachidori's own module from the tree `npm test`'s
 * pretest unpacks (scripts/sync-extension.mjs), so a pin that changes these requests or this
 * requirement fails here: then relay_media.rs is checked against the new behaviour (and can go,
 * once Hachidori takes the stored name itself).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { attachAnkiAddMedia, createAnkiMediaStore } = await import(
  new URL('../extensions/hachidori/anki-media.js', import.meta.url).href
)

const IMAGE = `hachidori_${'ab'.repeat(32)}.png`
const DATA = Buffer.from('not really a png').toString('base64')
/** A card whose definition holds a dictionary image, as `prepareAdd` hands it over (anki-worker.js). */
const card = () => ({
  note: { fields: { Expression: '注目', MainDefinition: `<div>ちゅうもく <img src="${IMAGE}"> notice</div>` } },
  files: [{ filename: IMAGE, data: DATA, type: 'picture', kind: 'dictionary image', required: true }]
})

/** `invoke(action, params)` over `answer`, recording the requests. */
function server(answer) {
  const seen = []
  const invoke = async (action, params) => {
    seen.push({ action, params })
    return answer(action, params)
  }
  return { seen, invoke }
}

test('a dictionary image goes up in a multi of storeMediaFile, before the note', async () => {
  const { note, files } = card()
  const { seen, invoke } = server((action, params) => {
    assert.equal(action, 'multi')
    return params.actions.map((call) => ({ result: call.params.filename, error: null }))
  })
  assert.deepEqual(await attachAnkiAddMedia(note, files, invoke), [])
  assert.deepEqual(seen, [
    {
      action: 'multi',
      params: {
        actions: [{ action: 'storeMediaFile', params: { filename: IMAGE, data: DATA, deleteExisting: false } }]
      }
    }
  ])
  assert.match(note.fields.MainDefinition, new RegExp(`<img src="${IMAGE}">`), 'the note names the file it sent')
})

test('a file stored under another name refuses the card: what the relay prevents', async () => {
  const { note, files } = card()
  // Manatan SRS: every file is converted and named after its content.
  const { invoke } = server((_action, params) =>
    params.actions.map(() => ({ result: 'mtn_5bc25953af610367041da419028c984f.avif', error: null }))
  )
  await assert.rejects(attachAnkiAddMedia(note, files, invoke), {
    message: 'Anki stored media under a different filename.'
  })
})

test('a card updated in place asks whether the file is there, stores it, and asks again', async () => {
  // anki-media.js `ensure` (the path for an overwrite or a duplicate scope other than the note
  // type). The relay answers getMediaFilesNames itself when the server has no such action.
  const stored = new Set()
  const { seen, invoke } = server((action, params) => {
    if (action === 'getMediaFilesNames') return stored.has(params.pattern) ? [params.pattern] : []
    assert.equal(action, 'storeMediaFile')
    stored.add(params.filename)
    return params.filename
  })
  const file = await createAnkiMediaStore().ensure({ invoke, filename: IMAGE, kind: 'dictionary image', data: DATA })
  assert.equal(file.status, 'stored')
  assert.deepEqual(
    seen.map(({ action, params }) => [action, params.pattern ?? params.filename, params.deleteExisting]),
    [
      ['getMediaFilesNames', IMAGE, undefined],
      ['storeMediaFile', IMAGE, false],
      ['getMediaFilesNames', IMAGE, undefined]
    ]
  )
})
