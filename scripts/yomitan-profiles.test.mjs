/**
 * Which Built-in Yomitan profile an account uses (ui/yomitan-profiles.ts): one Japanese account on
 * the default profile changes nothing, another language gets a profile of its own, a link to a
 * deleted profile is repaired, and a profile chosen in Settings → Account is kept.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const {
  planYomitanProfile,
  planModifications,
  profileState,
  normalizeLinks,
  yomitanLanguage,
  uniqueProfileName,
  recommendedSets,
  accountSlot
} = await load('yomitan-profiles.ts')

const profile = (name, language = 'ja', dictionaries = 1) => ({ name, language, dictionaries })
const plan = (overrides) =>
  planYomitanProfile({
    account: 'local',
    language: 'ja',
    links: {},
    state: { profiles: [profile('Default')], current: 0 },
    trigger: 'change',
    ...overrides
  })

test('one Japanese account on the default profile: nothing at all, at start or on a change', () => {
  assert.deepEqual(plan({ trigger: 'startup' }), { kind: 'keep' })
  assert.deepEqual(plan({ trigger: 'change' }), { kind: 'keep' })
  // Japanese at start, never linked, on a profile set to another language: still left alone.
  assert.deepEqual(
    plan({ trigger: 'startup', state: { profiles: [profile('Default'), profile('Mine', 'en')], current: 1 } }),
    { kind: 'keep' }
  )
})

test('a second account learning another language gets a new profile, copied from the default', () => {
  const links = { local: { profile: 'Default', language: 'ja' } }
  const result = plan({ account: 'acct-2', language: 'ko', links })
  assert.deepEqual(result, {
    kind: 'create',
    name: 'Korean',
    language: 'ko',
    link: { profile: 'Korean', language: 'ko' }
  })
  const options = { profileCurrent: 0, profiles: [{ name: 'Default', options: { general: { language: 'ja' }, dictionaries: [{ name: 'Jitendex', enabled: true }] } }] }
  const targets = planModifications(result, options, { ko: [{ modification: { action: 'set', path: 'scanning.scanResolution', value: 'word' } }] })
  assert.equal(targets[0].action, 'splice')
  assert.equal(targets[0].start, 1)
  const made = targets[0].items[0]
  assert.equal(made.name, 'Korean')
  assert.equal(made.options.general.language, 'ko')
  assert.equal(made.options.scanning.scanResolution, 'word')
  assert.deepEqual(made.options.dictionaries, [{ name: 'Jitendex', enabled: true }], 'dictionaries are left as they are')
  assert.equal(options.profiles[0].options.general.language, 'ja', 'the default profile is not touched')
  assert.deepEqual(targets[1], { scope: 'global', action: 'set', path: 'profileCurrent', value: 1 })
})

test('switching back to the first account brings its profile back', () => {
  const links = { 'acct-2': { profile: 'Korean', language: 'ko' } }
  const state = { profiles: [profile('Default'), profile('Korean', 'ko')], current: 1 }
  assert.deepEqual(plan({ links, state }), { kind: 'use', index: 0, link: { profile: 'Default', language: 'ja' } })
  // And to the second, through its link.
  const back = { ...links, local: { profile: 'Default', language: 'ja' } }
  assert.deepEqual(plan({ account: 'acct-2', language: 'ko', links: back, state: { ...state, current: 0 } }), {
    kind: 'use',
    index: 1,
    link: null
  })
})

test('a Japanese account never linked leaves Yomitan alone on any trigger, whatever its profile says', () => {
  const state = { profiles: [profile('Default', 'en')], current: 0 }
  assert.deepEqual(plan({ state, trigger: 'change' }), { kind: 'keep' })
  assert.deepEqual(plan({ state, trigger: 'startup' }), { kind: 'keep' })
})

test('a profile already in the language is used, and a name in use is not taken twice', () => {
  const state = { profiles: [profile('Default'), profile('English', 'en')], current: 0 }
  assert.deepEqual(plan({ account: 'a', language: 'en', state, links: { local: { profile: 'Default', language: 'ja' } } }), {
    kind: 'use',
    index: 1,
    link: { profile: 'English', language: 'en' }
  })
  assert.equal(uniqueProfileName('English', state.profiles), 'English (2)')
  assert.equal(uniqueProfileName('French', state.profiles), 'French')
})

test('a first run in another language: the empty default profile takes the language', () => {
  const state = { profiles: [profile('Default', 'ja', 0)], current: 0 }
  const result = plan({ language: 'en', state })
  assert.deepEqual(result, { kind: 'adopt', index: 0, language: 'en', link: { profile: 'Default', language: 'en' } })
  const targets = planModifications(result, { profiles: [{ options: {} }] }, {})
  assert.deepEqual(targets.map((t) => t.path), ['profiles[0].options.general.language', 'profileCurrent'])
  // Not when another account uses it.
  assert.equal(plan({ language: 'en', state, links: { other: { profile: 'Default', language: 'ja' } } }).kind, 'create')
})

test('a link to a deleted or renamed profile is repaired', () => {
  // Deleted: nothing else in the language, so the default profile, and the link is rewritten.
  const links = { a: { profile: 'Gone', language: 'en', chosen: true } }
  const state = { profiles: [profile('Default'), profile('Spare', 'de')], current: 1 }
  assert.deepEqual(plan({ account: 'a', language: 'en', links, state }), {
    kind: 'use',
    index: 0,
    link: { profile: 'Default', language: 'en' }
  })
  // Renamed: found again by its language.
  const renamed = { profiles: [profile('Default'), profile('My English', 'en')], current: 0 }
  assert.deepEqual(plan({ account: 'a', language: 'en', links, state: renamed }), {
    kind: 'use',
    index: 1,
    link: { profile: 'My English', language: 'en' }
  })
})

test('a profile chosen in Settings → Account is kept, whatever its language', () => {
  const links = { local: { profile: 'Custom', language: 'ja', chosen: true } }
  const state = { profiles: [profile('Default'), profile('Custom', 'en')], current: 0 }
  assert.deepEqual(plan({ links, state }), { kind: 'use', index: 1, link: null })
  assert.deepEqual(plan({ links, state: { ...state, current: 1 } }), { kind: 'keep' })
  // Reordered in Yomitan: found by name.
  const reordered = { profiles: [profile('Custom', 'en'), profile('Default')], current: 0 }
  assert.deepEqual(plan({ links, state: reordered }), { kind: 'keep' })
  // A new language looks again.
  assert.equal(plan({ links, state: { ...state, current: 1 }, language: 'en' }).kind, 'use')
})

test('switching back to a language used before reuses its profile, never "Korean (2)"', () => {
  // Carries out each plan the way followYomitanProfiles does, then returns the profile in use.
  const run = (world, account, language) => {
    const result = planYomitanProfile({ account, language, links: world.links, state: world.state, trigger: 'change' })
    const { profiles } = world.state
    if (result.kind === 'create') {
      world.state = { profiles: [...profiles, profile(result.name, result.language)], current: profiles.length }
    } else if (result.kind === 'adopt') {
      const next = profiles.map((p, i) => (i === result.index ? { ...p, language: result.language } : p))
      world.state = { profiles: next, current: result.index }
    } else if (result.kind === 'use') {
      world.state = { profiles, current: result.index }
    }
    if (result.kind !== 'keep' && result.link) world.links = { ...world.links, [account]: result.link }
    return world.state.profiles[world.state.current].name
  }
  const names = (world) => world.state.profiles.map((p) => p.name)

  for (const middle of ['zh-Hans', 'ja', 'en']) {
    const world = { links: {}, state: { profiles: [profile('Default')], current: 0 } }
    assert.equal(run(world, 'local', 'ja'), 'Default')
    assert.equal(run(world, 'local', 'ko'), 'Korean')
    run(world, 'local', middle)
    assert.equal(run(world, 'local', 'ko'), 'Korean', `ko → ${middle} → ko`)
    run(world, 'local', middle)
    assert.equal(run(world, 'local', 'ko'), 'Korean', `ko → ${middle} → ko, twice`)
    assert.equal(names(world).filter((n) => n.startsWith('Korean')).length, 1)
    assert.equal(new Set(names(world)).size, names(world).length, 'no profile made twice')
  }

  // Back to Japanese: the default profile, again and again.
  const world = { links: {}, state: { profiles: [profile('Default')], current: 0 } }
  for (let i = 0; i < 3; i++) {
    assert.equal(run(world, 'local', 'ko'), 'Korean')
    assert.equal(run(world, 'local', 'ja'), 'Default')
  }
  assert.deepEqual(names(world), ['Default', 'Korean'])

  // Found by its language even after the profiles were reordered in Yomitan.
  world.state = { profiles: [profile('Korean', 'ko'), profile('Default')], current: 1 }
  assert.equal(run(world, 'local', 'ko'), 'Korean')
  assert.equal(world.state.profiles.length, 2)

  // Two accounts taking turns in different languages share nothing and make nothing twice.
  const two = { links: {}, state: { profiles: [profile('Default')], current: 0 } }
  let chinese = null
  for (let i = 0; i < 3; i++) {
    assert.equal(run(two, 'local', 'ja'), 'Default')
    assert.equal(run(two, 'acct-2', 'ko'), 'Korean')
    const zh = run(two, 'acct-2', 'zh-Hant')
    chinese ??= zh
    assert.equal(zh, chinese)
    assert.equal(run(two, 'acct-2', 'ko'), 'Korean')
  }
  assert.equal(names(two).length, 3)
})

test('codes, links and options are read defensively', () => {
  assert.equal(yomitanLanguage('zh-Hans'), 'zh')
  assert.equal(yomitanLanguage('zh-Hant'), 'zh')
  assert.equal(yomitanLanguage('yue'), 'yue')
  assert.equal(yomitanLanguage('en'), 'en')
  assert.equal(yomitanLanguage('nonsense'), 'ja')
  assert.equal(accountSlot(null), 'local')
  assert.equal(accountSlot('cloud-1'), 'cloud-1')
  assert.deepEqual(normalizeLinks({ a: { profile: 'X', language: 'en' }, b: { profile: 3 }, c: null }), {
    a: { profile: 'X', language: 'en' }
  })
  assert.deepEqual(normalizeLinks('junk'), {})
  assert.deepEqual(
    profileState({ profileCurrent: 9, profiles: [{ name: 'A', options: { general: { language: 'en' }, dictionaries: [{ enabled: true }, { enabled: false }] } }] }),
    { profiles: [{ name: 'A', language: 'en', dictionaries: 1 }], current: 0 }
  )
  assert.deepEqual(plan({ state: { profiles: [], current: 0 } }), { kind: 'keep' })
  assert.deepEqual(
    recommendedSets({ en: [{ modification: { action: 'set', path: 'a.b', value: 1 } }, { modification: { action: 'delete', path: 'c' } }] }, 'en'),
    [{ path: 'a.b', value: 1 }]
  )
})

const { DICTIONARY_ENGINES, dictionaryEngineReads, effectiveDictionaryEngine, dictionaryEngineLanguageReason } =
  await load('settings.ts')

test('10ten and Hachidori read Japanese only; Yomitan stands in for them in another language', () => {
  assert.deepEqual(DICTIONARY_ENGINES.tenten.languages, ['ja'])
  assert.deepEqual(DICTIONARY_ENGINES.hachidori.languages, ['ja'])
  assert.equal(DICTIONARY_ENGINES.yomitan.languages, undefined)
  assert.equal(DICTIONARY_ENGINES['custom-api'].languages, undefined)
  for (const engine of Object.keys(DICTIONARY_ENGINES)) {
    assert.equal(effectiveDictionaryEngine(engine, 'ja'), engine, 'Japanese keeps every choice')
    assert.equal(dictionaryEngineLanguageReason(engine, 'ja'), null)
  }
  assert.equal(effectiveDictionaryEngine('tenten', 'en'), 'yomitan')
  assert.equal(effectiveDictionaryEngine('hachidori', 'zh-Hans'), 'yomitan')
  assert.equal(effectiveDictionaryEngine('custom-api', 'ko'), 'custom-api')
  assert.equal(dictionaryEngineReads('yomitan', 'ru'), true)
  assert.equal(dictionaryEngineLanguageReason('tenten', 'en'), '10ten reads Japanese only.')
  // An unknown code reads as Japanese.
  assert.equal(effectiveDictionaryEngine('tenten', 'xx'), 'tenten')
})
