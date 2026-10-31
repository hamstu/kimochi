import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { load } from './load.mjs'
import { markScanPublished } from '../ui/scan-publication.js'

const source = await readFile(new URL('../ui/overlay.js', import.meta.url), 'utf8')
const ast = ts.createSourceFile('overlay.js', source, ts.ScriptTarget.Latest, true)
const functions = ast.statements
  .filter(
    (node) =>
      ts.isFunctionDeclaration(node) && ['publishAccepted', 'applyResult'].includes(node.name?.text)
  )
  .map((node) => node.getText(ast))
  .join('\n')

test('the real overlay application awaits native publication before releasing its caller', async () => {
  let finish
  const ack = new Promise((resolve) => {
    finish = resolve
  })
  let drawn = 0
  let history = 0
  const context = vm.createContext({
    markScanPublished,
    sessionStorage: { setItem() {} },
    native: { publishScanState: () => ack },
    state: {},
    generation: { isStale: () => false },
    foreground: { current: null },
    draw: () => {
      drawn++
    },
    setting: () => null,
    publishOcrResult: async () => {
      history++
      return 'text'
    },
    log: () => {}
  })
  vm.runInContext(functions, context)
  let returned = false
  const result = context
    .applyResult({ geometry: false, fullText: 'text' }, { id: 1 }, { source: {} })
    .then(() => {
      returned = true
    })
  await Promise.resolve()
  assert.equal(returned, false)
  assert.equal(drawn, 0)
  assert.equal(history, 0)
  finish()
  await result
  assert.equal(drawn, 1)
  assert.equal(history, 1)
})

test('a refused native publication is not presented as a successful overlay result', async () => {
  const context = vm.createContext({
    native: {
      publishScanState: async () => {
        throw new Error('gone: evicted frame')
      }
    },
    state: {},
    generation: { isStale: () => false },
    foreground: { current: null },
    draw: () => assert.fail('must not draw'),
    publishOcrResult: () => assert.fail('must not publish')
  })
  vm.runInContext(functions, context)
  await assert.rejects(
    context.applyResult({ geometry: false }, { id: 1 }, { source: {} }),
    /evicted frame/
  )
})

test('the overlay tells the activity feed how a result ended', async () => {
  const posts = []
  const reports = []
  const context = vm.createContext({
    markScanPublished,
    sessionStorage: { setItem() {} },
    native: { publishScanState: async () => undefined },
    state: {},
    generation: { isStale: () => false, current: 1 },
    foreground: { current: null },
    draw: () => {},
    setting: () => null,
    publishOcrResult: async (_result, options) => {
      options.onPublication?.({ lines: 2, duplicate: false })
      return 'text'
    },
    log: () => {},
    publish: () => {},
    rejectFrame: () => {},
    activity: (post) => posts.push(post),
    scanActivity: { sourceChanged: () => ({ text: 'source changed', key: 'scan' }) },
    autoRound: null
  })
  vm.runInContext(functions, context)

  // An applied result hands the publisher's report to whoever is waiting for it.
  await context.applyResult({ geometry: false, fullText: 'text' }, { id: 1 }, { source: {} }, {
    publish: true,
    onPublication: (report) => reports.push(report)
  })
  assert.deepEqual(reports, [{ lines: 2, duplicate: false }])
  assert.deepEqual(posts, [])

  // A stale one says it was discarded, rather than ending in silence.
  context.generation.isStale = () => true
  await context.applyResult({ geometry: false, fullText: 'text' }, { id: 2 }, { source: {} })
  assert.deepEqual(
    posts.map((post) => post.text),
    ['source changed']
  )

  // Inside an automatic recognition it is kept for the round's one outcome instead.
  context.autoRound = { lines: 0, duplicate: false, outcome: null }
  await context.applyResult({ geometry: false, fullText: 'text' }, { id: 3 }, { source: {} })
  assert.equal(posts.length, 1)
  assert.equal(context.autoRound.outcome.text, 'source changed')
})

const scanPath = ast.statements
  .filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      [
        'performScan',
        'reportOutcome',
        'beginAutoRound',
        'noteAutoPublication',
        'settleAutoRound',
        'onAutoScanEvent'
      ].includes(node.name?.text)
  )
  .map((node) => node.getText(ast))
  .join('\n')

/**
 * The real scan path with every stage stubbed: `recognise` and `applied` decide how the scan
 * goes, and `sounds` records what the player was asked for (before the setting or throttle).
 */
async function scanContext({ recognise = async () => ({ fullText: 'text' }), applied } = {}) {
  const scanActivity = await load('scan-activity.ts')
  const { outcomeSound } = await load('sounds.ts')
  const sounds = []
  const context = vm.createContext({
    scanActivity,
    outcomeSound,
    playSound: (name, options = {}) => sounds.push([name, Boolean(options.auto)]),
    activity: () => {},
    trace: () => {},
    log: () => {},
    draw: () => {},
    publish: () => {},
    setScanning: (scanning) => {
      context.state.scanning = scanning
    },
    observationFrom: () => null,
    observerArgs: () => ['text', null],
    beginJob: async () => ({ request: {} }),
    setting: (key) => (key === 'autoOCRSettings' ? { observerMode: 'text' } : 'meikiocr'),
    recognize: (...args) => recognise(...args),
    applyResult: async (_result, _frame, _job, outcome) => {
      if (applied) outcome.onPublication?.(applied)
      return applied?.lines ? 'text' : ''
    },
    native: { captureFrame: async () => ({ id: 1 }) },
    scanner: { isRunning: false, noteExternalScan: () => {} },
    pipeline: { run: (work) => work() },
    generation: { current: 1, isStale: () => false },
    state: { scanning: false },
    autoRound: null
  })
  vm.runInContext(scanPath, context)
  return { context, sounds }
}

test('a scan the reader asks for plucks at the start and chimes when lines are added', async () => {
  const { context, sounds } = await scanContext({ applied: { lines: 2, duplicate: false } })
  await context.performScan()
  assert.deepEqual(sounds, [
    ['scan-start', false],
    ['scan-done', false]
  ])
})

test('a repeat or an empty reading ends a scan without a chime', async () => {
  for (const applied of [{ lines: 0, duplicate: true }, { lines: 0, duplicate: false }]) {
    const { context, sounds } = await scanContext({ applied })
    await context.performScan()
    assert.deepEqual(sounds, [
      ['scan-start', false],
      [null, false]
    ])
  }
  const { context, sounds } = await scanContext({ recognise: async () => null })
  await context.performScan()
  assert.deepEqual(sounds, [
    ['scan-start', false],
    [null, false]
  ])
})

test('a failed scan buzzes', async () => {
  const { context, sounds } = await scanContext({
    recognise: async () => {
      throw new Error('connection refused')
    }
  })
  await context.performScan()
  assert.deepEqual(sounds, [
    ['scan-start', false],
    ['scan-error', false]
  ])
})

test('the automatic loop never plucks, chimes for lines, and buzzes as automatic', async () => {
  const { context, sounds } = await scanContext()
  context.beginAutoRound()
  context.noteAutoPublication({ lines: 1, duplicate: false })
  context.settleAutoRound()

  context.beginAutoRound()
  context.onAutoScanEvent({ type: 'skip', reason: 'empty-result' })
  context.settleAutoRound()

  context.beginAutoRound()
  context.onAutoScanEvent({ type: 'error', stage: 'recognize', message: 'connection refused' })
  context.settleAutoRound()

  context.onAutoScanEvent({ type: 'error', stage: 'capture', message: 'native: stream stopped' })
  // A manual scan holding the capture is not a failure, and makes no outcome at all.
  context.onAutoScanEvent({ type: 'error', stage: 'capture', message: 'busy: capture running' })

  assert.deepEqual(sounds, [
    ['scan-done', true],
    [null, true],
    ['scan-error', true],
    ['scan-error', true]
  ])
})
