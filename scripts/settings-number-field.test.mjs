/** Settings number inputs must preserve zero so media retention can be disabled. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/panels/settings/fields.tsx', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  jsx: 'transform',
  jsxFactory: 'element',
  banner: { js: 'function element(type, props) { return { type, props } }' },
  plugins: [
    {
      name: 'input-stub',
      setup(build) {
        build.onResolve({ filter: /^@kit$/ }, () => ({ path: 'kit', namespace: 'stub' }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const Input = "input"' }))
      }
    }
  ]
})
const { NumberField } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

test('number fields accept zero, fall back for empty input, and clamp to their bounds', () => {
  const committed = []
  const field = NumberField({ value: 50, min: 0, max: 500, step: 1, fallback: 50, onCommit: (n) => committed.push(n) })
  for (const value of ['0', '1', '', 'invalid', '-1', '501']) field.props.onChange({ target: { value } })
  assert.deepEqual(committed, [0, 1, 50, 50, 0, 500])
  const bounded = NumberField({
    value: 10,
    min: 10,
    max: 500,
    step: 1,
    fallback: 50,
    onCommit: (n) => committed.push(n)
  })
  bounded.props.onChange({ target: { value: '0' } })
  assert.equal(committed.at(-1), 10)
})
