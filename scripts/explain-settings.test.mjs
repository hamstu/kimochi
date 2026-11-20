/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * The Explain settings (ui/explain-settings.ts): the provider, model, effort and tier the Log's
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
    tier: null,
    prompt: undefined,
    focusPrompt: undefined
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

test('the efforts offered are the ones native lets through, and the defaults agree', async () => {
  const explain = await readFile(new URL('../src-tauri/src/reader/explain.rs', import.meta.url), 'utf8')
  const openai = await readFile(new URL('../src-tauri/src/reader/openai.rs', import.meta.url), 'utf8')
  for (const [provider, rust, constant] of [
    ['claude', explain, 'CLAUDE_EFFORTS'],
    ['codex', explain, 'CODEX_EFFORTS'],
    ['openai', openai, 'EFFORTS']
  ]) {
    const listed = rust.match(new RegExp(`\\b${constant}: &\\[&str\\] = &\\[([^\\]]*)\\]`))[1]
    const allowed = [...listed.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(
      settings.EXPLAIN_EFFORTS[provider].map((e) => e.value),
      allowed
    )
  }
  assert.match(openai, new RegExp(`DEFAULT_MODEL: &str = "${settings.OPENAI_DEFAULT_MODEL}"`))
  const tiers = openai.match(/\bTIERS: &\[&str\] = &\[([^\]]*)\]/)[1]
  // The same set: the settings list Fast first, as recommended.
  assert.deepEqual(
    settings.OPENAI_TIERS.map((t) => t.value).sort(),
    [...tiers.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort()
  )
})

test('the OpenAI models offered by name: Luna first and recommended, each with a price', () => {
  assert.equal(settings.OPENAI_MODELS[0].value, settings.OPENAI_DEFAULT_MODEL)
  assert.match(settings.OPENAI_MODELS[0].label, /\(recommended\)$/)
  for (const model of settings.OPENAI_MODELS) {
    assert.ok(settings.explainPrice(model.value, 'default') > 0, model.value)
  }
  assert.deepEqual(settings.OPENAI_MODELS.map((m) => m.value).sort(), Object.keys(settings.OPENAI_PRICES).sort())
  // Empty is the default model, so listed; a name typed in is not.
  assert.equal(settings.listedOpenaiModel(''), true)
  assert.equal(settings.listedOpenaiModel(' gpt-6-sol '), true)
  assert.equal(settings.listedOpenaiModel('gpt-4.1-mini'), false)
})

test("OpenAI's tier is Fast unless another the model takes is chosen; Ultrafast only where offered", () => {
  const openai = (more) => settings.explainSettings({ explainProvider: 'openai', ...more })
  assert.equal(openai({}).tier, 'fast')
  assert.equal(openai({ explainOpenaiTier: 'default' }).tier, 'default')
  assert.equal(openai({ explainOpenaiTier: 'bogus' }).tier, 'fast')
  // Ultrafast: gpt-6.1-sol and gpt-6-astra take it; the default model does not, so it is Fast.
  assert.equal(openai({ explainOpenaiTier: 'ultrafast' }).tier, 'fast')
  assert.equal(openai({ explainOpenaiModel: 'gpt-6.1-sol', explainOpenaiTier: 'ultrafast' }).tier, 'ultrafast')
  assert.deepEqual(
    settings.openaiTiers(null).map((t) => t.value),
    ['fast', 'default']
  )
  assert.deepEqual(
    settings.openaiTiers('gpt-6-astra').map((t) => t.value),
    ['fast', 'default', 'ultrafast']
  )
  assert.equal(settings.OPENAI_TIERS[0].label, 'Fast (recommended)')
  assert.equal(settings.explainSettings({ explainProvider: 'claude', explainOpenaiTier: 'fast' }).tier, null)
  assert.match(settings.providerLabel(openai({})), / · fast$/)
  assert.doesNotMatch(settings.providerLabel(openai({ explainOpenaiTier: 'default' })), /fast|default/)
})

test('the price preview: a typical explanation with the model and tier chosen, twice as much on Fast', () => {
  const normal = settings.explainPrice(null, 'default')
  const fast = settings.explainPrice('gpt-6-luna', 'fast')
  // gpt-6-luna: $0.10 in and $0.50 out per million tokens; Fast twice that.
  assert.ok(Math.abs(normal - (500 * 0.1 + 120 * 0.5) / 1e6) < 1e-12)
  assert.ok(Math.abs(fast - 2 * normal) < 1e-12)
  assert.equal(settings.explainPrice('gpt-6-astra', 'default') > 50 * normal, true)
  assert.equal(settings.explainPrice('some-other-model', 'default'), null)
  // Ultrafast: six times Normal where offered, no estimate where not.
  assert.ok(
    Math.abs(settings.explainPrice('gpt-6.1-sol', 'ultrafast') - 6 * settings.explainPrice('gpt-6.1-sol', 'default')) <
      1e-12
  )
  assert.equal(settings.explainPrice('gpt-6-luna', 'ultrafast'), null)
  // Unset is Fast's price, as Explain asks for Fast then.
  assert.equal(settings.explainPrice(null, null), fast)
  assert.equal(settings.priceText(normal), 'About $0.0001 per explanation, or roughly 9,100 explanations for $1.')
  assert.equal(settings.priceText(fast), 'About $0.0002 per explanation, or roughly 4,500 explanations for $1.')
  // An expensive model: rounded to tens, never to "0 for $1".
  assert.equal(
    settings.priceText(settings.explainPrice('gpt-6-astra', 'fast')),
    'About $0.022 per explanation, or roughly 45 explanations for $1.'
  )
  assert.equal(settings.priceText(0.004), 'About $0.004 per explanation, or roughly 250 explanations for $1.')
  assert.equal(settings.priceText(2), 'About $2 per explanation.')
})

test('OpenAI reads its own model and effort, with its default model named', () => {
  const openai = (more) => settings.explainSettings({ explainProvider: 'openai', ...more })
  // Unset, the effort is None, as in the Log's defaults; stored empty, the model's own.
  assert.deepEqual(openai({}), {
    provider: 'openai',
    model: null,
    effort: 'none',
    tier: 'fast',
    prompt: undefined,
    focusPrompt: undefined
  })
  assert.equal(openai({ explainOpenaiEffort: '' }).effort, null)
  const chosen = openai({
    explainOpenaiModel: ' gpt-4.1-mini ',
    explainOpenaiEffort: 'minimal',
    explainClaudeEffort: 'max',
    explainCodexModel: 'other'
  })
  assert.equal(chosen.model, 'gpt-4.1-mini')
  assert.equal(chosen.effort, 'minimal')
  assert.equal(openai({ explainOpenaiEffort: 'ultra' }).effort, null)
  assert.equal(openai({ explainOpenaiEffort: 'max' }).effort, 'max')
  assert.equal(settings.providerLabel(openai({})), `OpenAI · ${settings.OPENAI_DEFAULT_MODEL} · no thinking · fast`)
  assert.equal(
    settings.providerLabel(openai({ explainOpenaiEffort: '', explainOpenaiTier: 'default' })),
    `OpenAI · ${settings.OPENAI_DEFAULT_MODEL}`
  )
  assert.equal(settings.providerLabel(chosen), 'OpenAI · gpt-4.1-mini · minimal effort · fast')
  // Kimochi cloud has neither.
  assert.deepEqual(settings.explainSettings({ explainProvider: 'kimochi', explainOpenaiModel: 'x' }).model, null)
})
