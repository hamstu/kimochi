/**
 * Hachidori in the language being learned (ui/hachidori-languages.ts): which languages it reads
 * (its release's packs), and the requests that bring its lookups to one: its profile, its
 * "Multiple languages" switch, its selection. A Japanese-only Hachidori is never written to.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from './load.mjs'

const {
  HACHIDORI_PACKS,
  HACHIDORI_READS,
  hachidoriLanguage,
  activeHachidoriProfile,
  planHachidoriLanguage,
  applyHachidoriLanguage
} = await load('hachidori-languages.ts')

const record = JSON.parse(await readFile(new URL('../extensions/hachidori.languages.json', import.meta.url), 'utf8'))

test('the languages are the release’s packs, mapped onto Kimochi’s codes', () => {
  assert.deepEqual(HACHIDORI_PACKS, record.codes)
  assert.equal(hachidoriLanguage('ja'), 'ja')
  assert.equal(hachidoriLanguage('zh-Hans'), 'zh')
  assert.equal(hachidoriLanguage('zh-Hant'), 'zh')
  assert.equal(hachidoriLanguage('yue'), null, 'Cantonese is not the Chinese pack')
  assert.equal(hachidoriLanguage('ko'), 'ko')
  assert.equal(hachidoriLanguage('th', ['ja', 'th']), 'th', 'a pack added upstream is read as soon as it ships')
  assert.equal(hachidoriLanguage('th', ['ja']), null)
  for (const code of HACHIDORI_READS) assert.ok(HACHIDORI_PACKS.includes(hachidoriLanguage(code)), code)
  assert.ok(HACHIDORI_READS.includes('ja'))
})

const flat = { revision: 3, hoverEnabled: true }
const withProfiles = (experimental, ...languages) => ({
  revision: 7,
  experimental,
  profiles: languages.map((language) => ({ id: language, language, settings: {}, packSettings: {} }))
})

test('Japanese on a Hachidori that never had another language: nothing to do', () => {
  assert.deepEqual(planHachidoriLanguage('ja', {}), { kind: 'keep' })
  assert.deepEqual(planHachidoriLanguage('ja', { options: flat }), { kind: 'keep' })
  assert.equal(activeHachidoriProfile({ options: flat }), 'ja')
})

test('another language: its profile, then the switch, then the selection', () => {
  assert.deepEqual(planHachidoriLanguage('zh-Hans', { options: flat }), { kind: 'add', language: 'zh', copyFrom: 'ja' })
  const added = withProfiles({ multipleLanguages: false }, 'ja', 'zh')
  assert.deepEqual(planHachidoriLanguage('zh-Hans', { options: added }), { kind: 'enable' })
  const on = withProfiles({ multipleLanguages: true }, 'ja', 'zh')
  assert.deepEqual(planHachidoriLanguage('zh-Hans', { options: on, languageSelection: { revision: 2 } }), {
    kind: 'select',
    profileId: 'zh'
  })
  const chosen = { options: on, languageSelection: { revision: 3, activeProfileId: 'zh' } }
  assert.deepEqual(planHachidoriLanguage('zh-Hant', chosen), { kind: 'keep' })
  assert.equal(activeHachidoriProfile(chosen), 'zh')
})

test('back to Japanese selects the Japanese profile, and adds it when it was removed', () => {
  const on = withProfiles({ multipleLanguages: true }, 'ja', 'zh')
  assert.deepEqual(
    planHachidoriLanguage('ja', { options: on, languageSelection: { revision: 3, activeProfileId: 'zh' } }),
    {
      kind: 'select',
      profileId: 'ja'
    }
  )
  const noJapanese = withProfiles({ multipleLanguages: true }, 'zh')
  assert.deepEqual(planHachidoriLanguage('ja', { options: noJapanese, languageSelection: { activeProfileId: 'zh' } }), {
    kind: 'add',
    language: 'ja',
    copyFrom: 'zh'
  })
  // The switch off: lookups are already Japanese.
  assert.deepEqual(planHachidoriLanguage('ja', { options: withProfiles({}, 'ja', 'zh') }), { kind: 'keep' })
})

test('a language Hachidori has no pack for is left to Yomitan', () => {
  assert.deepEqual(planHachidoriLanguage('yue', { options: flat }), { kind: 'keep' })
})

/** A small Hachidori: its records and the three requests, as its background answers them. */
function fakeHachidori(options, languageSelection) {
  const stored = { options, languageSelection }
  const sent = []
  return {
    stored,
    sent,
    port: {
      storage: async (keys) =>
        Object.fromEntries(keys.filter((k) => stored[k] !== undefined).map((k) => [k, stored[k]])),
      send: async (message) => {
        sent.push(message.type)
        const options = stored.options ?? {}
        if (message.type === 'hd_profile_add') {
          const profiles = Array.isArray(options.profiles)
            ? options.profiles
            : [{ id: 'ja', language: 'ja', settings: {}, packSettings: {} }]
          stored.options = {
            ...options,
            revision: (options.revision ?? 0) + 1,
            profiles: [...profiles, { id: message.language, language: message.language }]
          }
          return { ok: true }
        }
        if (message.type === 'hd_options_write') {
          if (message.baseRevision !== (options.revision ?? 0)) return { ok: false, conflict: true }
          stored.options = { ...options, ...message.options, revision: (options.revision ?? 0) + 1 }
          return { ok: true }
        }
        if (message.type === 'hd_language_selection_write') {
          const revision = stored.languageSelection?.revision ?? 0
          if (message.baseRevision !== revision) return { ok: false, conflict: true }
          stored.languageSelection = { revision: revision + 1, activeProfileId: message.activeProfileId }
          return { ok: true }
        }
        return { ok: false, error: 'unknown' }
      }
    }
  }
}

test('applying Chinese to a Japanese-only Hachidori, then Japanese again', async () => {
  const hachidori = fakeHachidori({ ...flat })
  assert.equal(await applyHachidoriLanguage('zh-Hans', hachidori.port), 'zh')
  assert.deepEqual(hachidori.sent, ['hd_profile_add', 'hd_options_write', 'hd_language_selection_write'])
  assert.equal(hachidori.stored.options.experimental.multipleLanguages, true)
  assert.equal(await applyHachidoriLanguage('zh-Hant', hachidori.port), 'zh')
  assert.equal(hachidori.sent.length, 3, 'already Chinese: nothing more')
  assert.equal(await applyHachidoriLanguage('ja', hachidori.port), 'ja')
  assert.deepEqual(hachidori.sent.slice(3), ['hd_language_selection_write'])
})

test('Japanese leaves a Japanese-only Hachidori untouched', async () => {
  const hachidori = fakeHachidori({ ...flat })
  assert.equal(await applyHachidoriLanguage('ja', hachidori.port), 'ja')
  assert.deepEqual(hachidori.sent, [])
})

test('a refusal is an error; it never loops', async () => {
  const hachidori = fakeHachidori({ ...flat })
  hachidori.port.send = async () => ({ ok: false, error: 'Add and remove languages on the linked Hachidori.' })
  await assert.rejects(applyHachidoriLanguage('ko', hachidori.port), /linked Hachidori/)
  const stuck = fakeHachidori({ ...flat })
  stuck.port.send = async () => ({ ok: false, conflict: true })
  await assert.rejects(applyHachidoriLanguage('ko', stuck.port), /did not settle on Korean/)
})
