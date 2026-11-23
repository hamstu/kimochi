/**
 * A refresh of Auto OCR publishes several passages; they reach the Log together, in one
 * `history_add_many`, in order, rather than one `history_add` (one history write and one Log
 * update each) after another (ui/output.js `publishOcrResults`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

/** Native as the overlay sees it: every command call recorded, answered by `answer`. */
const calls = []
let answer = () => null
globalThis.__TAURI__ = {
  core: {
    invoke: async (command, args) => {
      calls.push({ command, args })
      return answer(command, args)
    }
  },
  event: { listen: async () => () => {} }
}
const { publishOcrResults, publishOcrResult } = await load('output.js')
/** The history writes made so far, `history_add` or `history_add_many`. */
const writes = () => calls.filter((c) => c.command.startsWith('history_add'))

/** A text-only reading, as an engine with no boxes gives one: its whole text is one Log line. */
const reading = (text) => ({ geometry: false, fullText: text, textAnnotations: [], groups: [], engine: 'screenai' })

test("a refresh's readings reach the Log in one write, in order; a repeat is not sent on", async () => {
  calls.length = 0
  answer = (command, args) =>
    command === 'history_add_many'
      ? args.entries.map((entry, i) => ({
          id: `e${i}`,
          text: entry.text,
          ...(entry.text === 'Objetivos' ? { skipped: true } : {})
        }))
      : null
  const reports = []
  const published = await publishOcrResults([reading('Misiones activas'), reading('Objetivos'), reading('Encargos')], {
    merge: true,
    frame: 7,
    onPublication: (report) => reports.push(report)
  })
  assert.deepEqual(published, ['Misiones activas', '', 'Encargos'])
  const [write, ...more] = writes()
  assert.equal(more.length, 0, 'one write for the whole refresh')
  assert.equal(write.command, 'history_add_many')
  assert.deepEqual(
    write.args.entries.map((e) => [e.text, e.merge, e.frame, e.engine]),
    [
      ['Misiones activas', true, 7, 'screenai'],
      ['Objetivos', true, 7, 'screenai'],
      ['Encargos', true, 7, 'screenai']
    ]
  )
  // The clipboard and the texthooker get only what the history kept, in order, after it.
  assert.deepEqual(
    calls.filter((c) => c.command === 'texthooker_send').map((c) => c.args.text),
    ['Misiones activas', 'Encargos']
  )
  assert.deepEqual(reports, [
    { lines: 1, duplicate: false },
    { lines: 0, duplicate: true },
    { lines: 1, duplicate: false }
  ])
})

test('readings with nothing in them are reported and not written', async () => {
  calls.length = 0
  answer = (command, args) => (command === 'history_add_many' ? args.entries.map((e) => ({ text: e.text })) : null)
  const reports = []
  const published = await publishOcrResults([reading('  '), reading('Cerrar')], {
    onPublication: (report) => reports.push(report)
  })
  assert.deepEqual(published, ['', 'Cerrar'])
  const [write] = writes()
  assert.deepEqual(
    write.args.entries.map((e) => e.text),
    ['Cerrar']
  )
  assert.deepEqual(reports, [
    { lines: 0, duplicate: false },
    { lines: 1, duplicate: false }
  ])
  // Nothing worth writing at all: no write.
  calls.length = 0
  assert.deepEqual(await publishOcrResults([reading('')]), [''])
  assert.equal(writes().length, 0)
})

test('one capture is a batch of one', async () => {
  calls.length = 0
  answer = (command, args) => (command === 'history_add_many' ? args.entries.map((e) => ({ text: e.text })) : null)
  assert.equal(await publishOcrResult(reading('Detalles')), 'Detalles')
  assert.deepEqual(
    writes().map((c) => c.command),
    ['history_add_many']
  )
})

test('a refresh longer than the history keeps goes in batches of 50, in order', async () => {
  calls.length = 0
  answer = (command, args) => (command === 'history_add_many' ? args.entries.map((e) => ({ text: e.text })) : null)
  const texts = Array.from({ length: 53 }, (_, i) => `línea ${i}`)
  const published = await publishOcrResults(texts.map(reading))
  assert.deepEqual(published, texts)
  assert.deepEqual(
    writes().map((c) => c.args.entries.length),
    [50, 3]
  )
  assert.deepEqual(
    writes().flatMap((c) => c.args.entries.map((e) => e.text)),
    texts
  )
})

test('a reading native refuses is dropped alone; the rest of its refresh is published', async () => {
  calls.length = 0
  answer = (command, args) =>
    command === 'history_add_many'
      ? args.entries.map((e) =>
          e.text === 'Objetivos' ? { text: e.text, invalid: 'invalid: OCR groups need unique IDs' } : { text: e.text }
        )
      : null
  const reports = []
  const published = await publishOcrResults([reading('Detalles'), reading('Objetivos'), reading('Encargos')], {
    onPublication: (report) => reports.push(report)
  })
  assert.deepEqual(published, ['Detalles', '', 'Encargos'])
  assert.deepEqual(
    calls.filter((c) => c.command === 'texthooker_send').map((c) => c.args.text),
    ['Detalles', 'Encargos']
  )
  assert.deepEqual(reports[1], { lines: 0, duplicate: false })
})

// Last: native.js remembers a command it found missing, for the rest of the run.
test('without the batch command (the browser preview), each reading is written on its own, in order', async () => {
  calls.length = 0
  answer = (command, args) => {
    if (command === 'history_add_many') throw new Error('Command history_add_many not found')
    return command === 'history_add' ? { id: args.text, text: args.text } : null
  }
  const published = await publishOcrResults([reading('Radio macuto'), reading('Encargos')], { merge: true })
  assert.deepEqual(published, ['Radio macuto', 'Encargos'])
  assert.deepEqual(
    calls.filter((c) => c.command === 'history_add').map((c) => c.args.text),
    ['Radio macuto', 'Encargos']
  )
})
