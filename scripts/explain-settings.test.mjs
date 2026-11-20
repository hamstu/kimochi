/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * The Explain settings (ui/explain-settings.ts): the provider, model and effort the Log's
 * settings choose, and the efforts native lets through.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from './load.mjs'

const settings = await load('explain-settings.ts')

test("the provider and model are the Log's, with its defaults", () => {
  const model = (stored) => settings.explainSettings(stored).model
  assert.deepEqual(settings.explainSettings(undefined), {
    provider: 'codex',
    model: null,
    effort: null,
    prompt: undefined
  })
  assert.equal(model({ explainProvider: 'claude' }), 'opus')
  assert.equal(model({ explainProvider: 'claude', explainClaudeModel: ' sonnet ' }), 'sonnet')
  assert.equal(model({ explainProvider: 'codex', explainCodexModel: 'gpt-5' }), 'gpt-5')
  assert.equal(model({ explainProvider: 'kimochi', explainClaudeModel: 'opus' }), null)
  assert.equal(settings.explainSettings({ explainProvider: 'other' }).provider, 'codex')
  assert.equal(settings.providerLabel(settings.explainSettings({ explainProvider: 'kimochi' })), 'Kimochi cloud')
  assert.equal(settings.providerLabel(settings.explainSettings({ explainProvider: 'claude' })), 'Claude · opus')
  assert.equal(settings.providerLabel(settings.explainSettings({})), 'Codex')
})

test("the effort is the chosen provider's own, and only one its CLI takes", () => {
  const effort = (stored) => settings.explainSettings(stored).effort
  const both = { explainClaudeEffort: 'low', explainCodexEffort: 'minimal' }
  assert.equal(effort({ ...both, explainProvider: 'claude' }), 'low')
  assert.equal(effort({ ...both, explainProvider: 'codex' }), 'minimal')
  assert.equal(effort({ ...both, explainProvider: 'kimochi' }), null)
  // Empty is the CLI's default; one the CLI does not take is never sent.
  assert.equal(effort({ explainProvider: 'claude', explainClaudeEffort: '' }), null)
  assert.equal(effort({ explainProvider: 'claude', explainClaudeEffort: 'minimal' }), null)
  assert.equal(effort({ explainProvider: 'codex', explainCodexEffort: 'ultra' }), null)
  assert.equal(effort({ explainProvider: 'claude', explainClaudeEffort: 'none' }), null)
  assert.equal(effort({ explainProvider: 'codex', explainCodexEffort: 'none' }), 'none')
  assert.equal(
    settings.providerLabel(
      settings.explainSettings({ explainProvider: 'claude', explainClaudeModel: 'haiku', explainClaudeEffort: 'low' })
    ),
    'Claude · haiku · low effort'
  )
  assert.equal(
    settings.providerLabel(settings.explainSettings({ explainProvider: 'codex', explainCodexEffort: 'xhigh' })),
    'Codex · extra high effort'
  )
})

test('the efforts offered are the ones native lets through', async () => {
  const explain = await readFile(new URL('../src-tauri/src/reader/explain.rs', import.meta.url), 'utf8')
  for (const [provider, constant] of [
    ['claude', 'CLAUDE_EFFORTS'],
    ['codex', 'CODEX_EFFORTS']
  ]) {
    const listed = explain.match(new RegExp(`\\b${constant}: &\\[&str\\] = &\\[([^\\]]*)\\]`))[1]
    const allowed = [...listed.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(
      settings.EXPLAIN_EFFORTS[provider].map((e) => e.value),
      allowed
    )
  }
})
