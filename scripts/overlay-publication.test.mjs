import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

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
