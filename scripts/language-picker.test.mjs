// The language picker (frontend/components/LanguagePicker.tsx) and Settings → Language: the
// search, the per-language notes, the flags it bundles, and where the page and step are registered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { load } from './load.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8')

const { LANGUAGES, languageOf } = await load('languages.ts')
const { languageMatches } = await load('../frontend/components/languageSearch.ts')
const { comboboxMatches, foldText } = await load('../frontend/kit/comboboxFilter.ts')
const { languageNotes } = await load('../frontend/panels/settings/languageNotes.ts')

const search = (query) => LANGUAGES.filter((language) => languageMatches(language, query)).map((l) => l.code)

test('the search matches the English name, the endonym or the start of the code', () => {
  assert.equal(search('').length, LANGUAGES.length, 'an empty search lists everything')
  assert.deepEqual(search('japan'), ['ja'])
  assert.deepEqual(search('日本'), ['ja'], 'by endonym')
  assert.deepEqual(search('espanol'), ['es'], 'accents are ignored')
  assert.deepEqual(search('FRANÇAIS'), ['fr'], 'case is ignored')
  assert.deepEqual(search('zh'), ['zh-Hans', 'zh-Hant'], 'by code')
  assert.deepEqual(search('chinese trad'), ['zh-Hant'], 'each word on its own')
  assert.deepEqual(search('한국'), ['ko'])
  assert.ok(search('greek').includes('el') && search('greek').includes('grc'))
  assert.deepEqual(search('klingon'), [])
  // A code matches from its start only: "a" is not every code with an a in it.
  assert.ok(!search('ja').includes('la'))
})

test('the combobox search folds case and accents and needs every word', () => {
  assert.equal(foldText('Čeština'), 'cestina')
  assert.equal(comboboxMatches(['Tiếng Việt'], 'tieng viet'), true)
  assert.equal(comboboxMatches(['Scottish Gaelic', 'Gàidhlig'], 'gaelic scot'), true)
  assert.equal(comboboxMatches(['Irish'], 'irish gaelic'), false)
  assert.equal(comboboxMatches(['Anything'], '   '), true)
})

test('the notes come from the traits, and Japanese reads as before', () => {
  assert.deepEqual(languageNotes(languageOf('ja')), [
    'Written in kanji and kana.',
    'Words are written without spaces between them.',
    'Vertical text is looked for as well as horizontal.',
    'Furigana, the small readings beside kanji, can be filtered out of scans.'
  ])
  assert.deepEqual(languageNotes(languageOf('es')), ['Written in the Latin alphabet.', 'Words are separated by spaces.'])
  assert.deepEqual(languageNotes(languageOf('sh')), [
    'Written in the Latin alphabet or the Cyrillic alphabet.',
    'Words are separated by spaces.'
  ])
  for (const language of LANGUAGES) assert.ok(!languageNotes(language).some((note) => note.includes('undefined')), language.code)
})

test('every flag the table names is bundled by name, from a file the package has', async () => {
  const source = await read('frontend/components/languageFlags.ts')
  assert.ok(!/import\.meta\.glob/.test(source), 'a glob would bundle the whole flag set')
  const imports = new Map(
    [...source.matchAll(/^import (\w+) from 'circle-flags\/flags\/([\w/-]+)\.svg'$/gm)].map((m) => [m[1], m[2]])
  )
  const keys = new Map([...source.matchAll(/^ {2}'?([\w-]+)'?: (\w+),?$/gm)].map((m) => [m[1], m[2]]))
  for (const language of LANGUAGES) {
    if (!language.flag) continue
    const name = language.flag.replace(/^language\//, '')
    const binding = keys.get(name)
    assert.ok(binding, `${language.code}: no flag for ${language.flag}`)
    const file = imports.get(binding)
    assert.ok(file, `${language.code}: ${binding} is not imported`)
    assert.ok(existsSync(`${root}node_modules/circle-flags/flags/${file}.svg`), `${language.code}: no ${file}.svg`)
  }
  const pkg = JSON.parse(await read('package.json'))
  assert.match(pkg.dependencies['circle-flags'], /^\d+\.\d+\.\d+$/, 'circle-flags is pinned')
  assert.ok((await read('NOTICE')).includes('circle-flags'), 'NOTICE does not credit circle-flags')
  assert.ok((await read('frontend/credits/credits.ts')).includes("id: 'circle-flags'"), 'the credits do not list circle-flags')
})

test('Settings → Language is the second page, registered everywhere a page is', async () => {
  const nav = await read('frontend/panels/settings/settingsNav.tsx')
  const values = [...nav.matchAll(/\{ value: '(\w+)'/g)].map((m) => m[1])
  assert.deepEqual(values.slice(0, 2), ['general', 'language'])
  assert.match(await read('frontend/bridge/tauri.ts'), /\| 'language'/)
  assert.match(await read('frontend/panels/settings/settingsPages.ts'), /language: \(\) => import\('\.\/LanguageTab'\)/)
  assert.match(await read('frontend/panels/settings/SettingsPageFor.tsx'), /language: page\('language'\)/)
  assert.ok((await read('frontend/dev/studio/surfaces.ts')).includes("['language', 'Language']"))
})

test('the welcome guide asks for the language straight after the intro', async () => {
  const app = await read('frontend/welcome/WelcomeApp.tsx')
  assert.match(app, /<IntroStep next="\/language" \/>/)
  assert.match(app, /'intro',\s*'language',/, 'the language step is not second in the dots')
  assert.match(app, /'\/language': 'language'/)
  assert.match(await read('frontend/dev/preview-setup.ts'), /language: '\/language'/)
})
