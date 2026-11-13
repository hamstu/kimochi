/**
 * The language table (ui/languages.ts): every code is well formed and listed once, Japanese keeps
 * the traits the app was built on, and an unknown code reads as Japanese.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load } from './load.mjs'

const { LANGUAGES, LANGUAGE_CODES, DEFAULT_LANGUAGE, languageOf, isJapanese } = await load('languages.ts')

test('codes are BCP 47 language tags, each listed once, Japanese first', () => {
  assert.equal(LANGUAGE_CODES[0], 'ja')
  assert.equal(DEFAULT_LANGUAGE, 'ja')
  assert.equal(new Set(LANGUAGE_CODES).size, LANGUAGE_CODES.length)
  for (const code of LANGUAGE_CODES) assert.match(code, /^[a-z]{2,3}(-[A-Z][a-z]{3})?$/, code)
})

test('every language has a name, an endonym and at least one script', () => {
  for (const language of LANGUAGES) {
    assert.ok(language.name && language.endonym, language.code)
    assert.ok(language.scripts.length > 0, language.code)
    assert.ok(language.flag === null || /^(language\/)?[a-z]{2}(-[a-z]{2,3})?$/.test(language.flag), language.code)
  }
})

test('Japanese is unspaced, vertical and the only language with ruby', () => {
  const japanese = languageOf('ja')
  assert.deepEqual(
    { spaces: japanese.spaces, vertical: japanese.vertical, ruby: japanese.ruby, scripts: [...japanese.scripts] },
    { spaces: false, vertical: true, ruby: true, scripts: ['Jpan'] }
  )
  assert.deepEqual(LANGUAGES.filter((language) => language.ruby).map((language) => language.code), ['ja'])
})

test('traits of the other kinds of language', () => {
  assert.equal(languageOf('en').spaces, true)
  assert.equal(languageOf('ko').spaces, true)
  assert.equal(languageOf('ko').vertical, false)
  assert.equal(languageOf('zh-Hans').spaces, false)
  assert.equal(languageOf('th').spaces, false)
  assert.equal(languageOf('th').vertical, false)
  assert.deepEqual([...languageOf('sh').scripts], ['Latn', 'Cyrl'])
})

test('a code this build does not list reads as Japanese', () => {
  assert.equal(languageOf('tlh').code, 'ja')
  assert.equal(languageOf(undefined).code, 'ja')
  assert.equal(isJapanese('xx'), true)
  assert.equal(isJapanese('ja'), true)
  assert.equal(isJapanese('en'), false)
})

test('the native table (src-tauri/languages.json) is the TS table\'s native fields, in order', () => {
  const native = JSON.parse(readFileSync(new URL('../src-tauri/languages.json', import.meta.url), 'utf8'))
  assert.deepEqual(
    native,
    LANGUAGES.map(({ code, scripts, spaces, vertical, ruby }) => ({ code, scripts: [...scripts], spaces, vertical, ruby }))
  )
})
