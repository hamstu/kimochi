import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/welcome/welcome-actions.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  plugins: [
    {
      name: 'welcome-native',
      setup(builder) {
        builder.onResolve({ filter: /\/bridge\/(tauri|settings)$/ }, () => ({ path: 'native', namespace: 'test' }))
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: `
        const native = globalThis.__welcomeNative;
        export const nativeError = error => ({message: error instanceof Error ? error.message : String(error)});
        export const panel = (label, action) => native.panel(label, action);
        export const setSetting = (key, value) => native.save(key, value);
      `
        }))
      }
    }
  ]
})
let instance = 0
async function setup(fail = () => false) {
  const calls = []
  globalThis.__welcomeNative = {
    save: async (key, value) => {
      calls.push(['save', key, value])
      if (fail('save')) throw Error('Disk unavailable')
    },
    panel: async (label, action) => {
      calls.push([label, action])
      if (fail(label)) throw Error(`${label} window unavailable`)
    }
  }
  const source = compiled.outputFiles[0].text + `\n// instance ${instance++}`
  const { completeOnboarding } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  return { calls, complete: completeOnboarding }
}
const success = [
  ['save', 'hasCompletedOnboarding', true],
  ['log', 'show'],
  ['welcome', 'hide']
]

test('concurrent completion attempts share one ordered save/show/hide operation', async () => {
  const { calls, complete } = await setup()
  await Promise.all(Array.from({ length: 10 }, complete))
  assert.deepEqual(calls, success)
})

for (const [stage, expected, message] of [
  ['save', success.slice(0, 1), /save/i],
  ['log', success.slice(0, 2), /open/i],
  ['welcome', success, /close/i]
]) {
  test(`a ${stage} failure stops the handoff and repeated retries can recover`, async () => {
    let failing = true
    const { calls, complete } = await setup((step) => failing && step === stage)
    for (let attempt = 0; attempt < 2; attempt++) {
      const results = await Promise.allSettled([complete(), complete()])
      assert.equal(
        results.every((result) => result.status === 'rejected'),
        true
      )
      assert.match(results[0].reason.message, message)
      assert.deepEqual(calls.splice(0), expected)
    }
    failing = false
    await complete()
    assert.deepEqual(calls, success)
  })
}

test('a pending save cannot open or hide either window', async () => {
  const { calls, complete } = await setup()
  let resolve
  globalThis.__welcomeNative.save = (key, value) => {
    calls.push(['save', key, value])
    return new Promise((done) => {
      resolve = done
    })
  }
  const first = complete()
  const second = complete()
  assert.deepEqual(calls, success.slice(0, 1))
  resolve()
  await Promise.all([first, second])
  assert.deepEqual(calls, success)
})
