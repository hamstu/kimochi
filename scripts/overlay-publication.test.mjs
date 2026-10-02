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
