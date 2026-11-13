/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * The features that follow the language being read (the `language` setting): the Explain prompt,
 * the Log's word count, the Auto OCR watcher, the Text Hooker's defaults, DeepL's languages, the
 * Anki markers offered, VNDB titles and the debug report's summary. Beside each, Japanese is
 * checked to be exactly what it was before there was a language.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { load } from './load.mjs'

/** Bundle a module from `frontend/` and import it in-process. */
async function loadFrontend(entry) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(`../frontend/${entry}`, import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    alias: { '@ui': fileURLToPath(new URL('../ui', import.meta.url)) }
  })
  const code = Buffer.from(outputFiles[0].contents).toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

const prompt = await loadFrontend('texthooker/lib/explainPrompt.ts')
const { countWords } = await loadFrontend('texthooker/core/wordCount.ts')
const { DEEPL_SOURCES, deeplTranslates, translationErrorMessage } = await loadFrontend(
  'texthooker/lib/translateLanguage.ts'
)
const { JAPANESE_ONLY_MARKERS, YOMITAN_MARKERS, markersFor } = await loadFrontend('texthooker/lib/types.ts')
const { detectAnkiSetup } = await loadFrontend('texthooker/lib/ankiDetect.ts')
const { bestWatcher, resolveWatcher, watcherOffered } = await load('watcher.ts')
const { HOOK_DEFAULTS, hookDefaultsFor, hookSettings } = await load('hook-games.ts')
const { debugMarkdown } = await load('debug-report.ts')

test('the Explain prompt for Japanese is the prompt from before there was a language, exactly', () => {
  const template = prompt.defaultExplainPrompt('ja')
  assert.ok(template.includes('{{language}}'))
  const rendered = prompt.renderExplainPrompt(template, {
    language: 'Japanese',
    context: '{{context}}',
    sentence: '{{sentence}}'
  })
  assert.equal(rendered, prompt.LEGACY_EXPLAIN_PROMPT)
  // And as sent: a stored old default, the template and an empty prompt all render the same.
  const sent = prompt.LEGACY_EXPLAIN_PROMPT.replace('{{context}}', 'A\nB').replace('{{sentence}}', '「猫だ」')
  for (const stored of [prompt.LEGACY_EXPLAIN_PROMPT, template, '', undefined]) {
    assert.equal(prompt.explainPromptFor(stored, 'ja', 'A\nB', '「猫だ」'), sent)
  }
  // An unknown code reads as Japanese.
  assert.equal(prompt.explainPromptFor(undefined, 'xx', 'A', 'B'), prompt.explainPromptFor(undefined, 'ja', 'A', 'B'))
})

test('the Explain prompt for Korean names Korean and has none of the Japanese-only guidance', () => {
  const sent = prompt.explainPromptFor(prompt.LEGACY_EXPLAIN_PROMPT, 'ko', '앞 줄', '안녕하세요')
  assert.match(sent, /expert Korean tutor/)
  assert.match(sent, /native Korean media/)
  assert.match(sent, /Bold the Korean fragments/)
  assert.match(sent, /natural English translation/)
  assert.doesNotMatch(sent, /Japanese|「|』|particles, sentence-ending/)
  assert.ok(sent.endsWith('TARGET SENTENCE:\n안녕하세요'))
  assert.ok(sent.includes('PREVIOUS LINES (oldest first):\n앞 줄\n'))
})

test("a stored default follows the language; the reader's own prompt is sent as written", () => {
  for (const stored of [
    prompt.LEGACY_EXPLAIN_PROMPT,
    prompt.defaultExplainPrompt('ja'),
    prompt.defaultExplainPrompt('fr'),
    '  '
  ]) {
    assert.equal(prompt.isDefaultExplainPrompt(stored), true)
    assert.equal(prompt.explainTemplate(stored, 'de'), prompt.defaultExplainPrompt('de'))
  }
  const own = 'Explain {{sentence}} in simple {{language}}. Context: {{context}}'
  assert.equal(prompt.isDefaultExplainPrompt(own), false)
  assert.equal(prompt.explainTemplate(own, 'ko'), own)
  assert.equal(prompt.explainPromptFor(own, 'ko', 'c', 's'), 'Explain s in simple Korean. Context: c')
  // A custom prompt without the placeholder is untouched, for Japanese as before.
  assert.equal(prompt.explainPromptFor('Hi {{sentence}}', 'ja', 'c', 's'), 'Hi s')
})

test('words are counted by the language, for the stats of a language that spaces its words', () => {
  assert.equal(countWords('Hello, world! How are you?', 'en'), 5)
  assert.equal(countWords("C'est l'heure — on y va.", 'fr') >= 5, true)
  assert.equal(countWords('안녕하세요, 만나서 반갑습니다.', 'ko'), 3)
  assert.equal(countWords('Привет, как дела?', 'ru'), 3)
  assert.equal(countWords('  ……  ', 'en'), 0)
})

const on = (accelerator) => ({ available: true, ...(accelerator ? { accelerator } : {}) })
const JA = ['ja']

test('the watcher passes over engines that cannot read the language; MeikiOCR is a fallback for Japanese only', () => {
  const engines = {
    ppocr: { available: false },
    meikiocr: { ...on('cpu'), languages: JA },
    vocr: { ...on(), languages: JA }
  }
  // Japanese: unchanged.
  assert.equal(bestWatcher(engines), 'meikiocr')
  assert.equal(bestWatcher(engines, 'ja'), 'meikiocr')
  assert.deepEqual(resolveWatcher('vocr', engines, 'auto', 'ja'), { kind: 'text', engine: 'vocr', because: 'selected' })
  // Korean: neither MeikiOCR nor VOCR6 reads it.
  assert.equal(bestWatcher(engines, 'ko'), null)
  assert.deepEqual(resolveWatcher('googlelens', engines, 'meikiocr', 'ko'), { kind: 'image', because: 'none' })
  assert.deepEqual(resolveWatcher('vocr', engines, 'auto', 'ko'), { kind: 'image', because: 'none' })
  // MeikiOCR without a language list (an older backend) still is not a watcher for Korean.
  assert.equal(bestWatcher({ meikiocr: on('cpu') }, 'ko'), null)
  assert.equal(watcherOffered({ meikiocr: on('cpu') }, 'meikiocr', 'ko'), false)
  assert.equal(watcherOffered({ meikiocr: on('cpu') }, 'meikiocr', 'ja'), true)
  // Engines listing the language, or listing none, watch.
  const mac = {
    ppocr: on('cpu'),
    livetext: { ...on(), languages: ['ja', 'ko', 'en'] },
    meikiocr: { ...on(), languages: JA }
  }
  assert.equal(bestWatcher(mac, 'ko'), 'livetext')
  assert.equal(bestWatcher(mac, 'hi'), 'ppocr')
  assert.equal(resolveWatcher('googlelens', mac, 'livetext', 'hi').engine, 'ppocr')
})

test('the Text Hooker strips script codes by default only where words are not spaced; a stored value wins', () => {
  assert.equal(hookDefaultsFor({ spaces: false }), HOOK_DEFAULTS)
  assert.equal(hookDefaultsFor({ spaces: false }).stripCodes, true)
  assert.equal(hookDefaultsFor({ spaces: true }).stripCodes, false)
  assert.equal(hookSettings({ ...hookDefaultsFor({ spaces: true }) }, null).stripCodes, false)
  assert.equal(hookSettings({ ...hookDefaultsFor({ spaces: true }), stripCodes: true }, null).stripCodes, true)
  assert.equal(hookSettings(hookDefaultsFor({ spaces: true }), { stripCodes: true }).stripCodes, true)
})

test("DeepL's languages are native's, and its refusal reads as a sentence naming the language", async () => {
  const rust = await readFile(new URL('../src-tauri/src/language.rs', import.meta.url), 'utf8')
  const body = rust.slice(
    rust.indexOf('pub fn deepl_source'),
    rust.indexOf('_ => return None', rust.indexOf('pub fn deepl_source'))
  )
  const codes = body
    .split('\n')
    .filter((line) => line.includes('=>'))
    .flatMap((line) => [...line.split('=>')[0].matchAll(/"([A-Za-z-]+)"/g)].map((m) => m[1]))
  assert.deepEqual([...DEEPL_SOURCES].sort(), [...new Set(codes)].sort())
  assert.equal(deeplTranslates('ja'), true)
  assert.equal(deeplTranslates('hi'), false)
  assert.equal(
    translationErrorMessage(
      'DeepL cannot translate from this language (hi). Choose Kimochi cloud translation instead.',
      'hi'
    ),
    "DeepL can't translate from Hindi. Choose Kimochi cloud in Settings → Translation & AI."
  )
  assert.equal(translationErrorMessage('DeepL HTTP 403 (invalid key?)', 'ja'), 'DeepL HTTP 403 (invalid key?)')
})

const LAPIS = [
  'Expression',
  'ExpressionReading',
  'ExpressionAudio',
  'MainDefinition',
  'Sentence',
  'SentenceFurigana',
  'Frequency'
]
const SENREN = ['word', 'reading', 'definition', 'sentence', 'sentenceFurigana', 'pitchAccents']

test('furigana and pitch markers are offered, and detected, for Japanese only', async () => {
  assert.deepEqual(markersFor(true), YOMITAN_MARKERS)
  assert.deepEqual(
    markersFor(false),
    YOMITAN_MARKERS.filter((m) => !JAPANESE_ONLY_MARKERS.includes(m))
  )
  assert.ok(!markersFor(false).includes('sentence-furigana') && !markersFor(false).includes('pitch-accents'))
  const anki = (fields) => ({
    models: async () => ['Lapis', 'Senren'],
    fields: async (model) => fields[model],
    decks: async () => ['Mining'],
    findNotes: async (query) => (query.includes('Lapis') ? [1, 2, 3] : [4])
  })
  const reader = anki({ Lapis: LAPIS, Senren: SENREN })
  const ja = await detectAnkiSetup(reader)
  const ko = await detectAnkiSetup(reader, { japanese: false })
  assert.ok(ja.ok && ko.ok)
  const markers = (found) => found.fieldMappings.map((m) => m.marker).filter(Boolean)
  assert.ok(markers(ja).includes('sentence-furigana'))
  assert.ok(!markers(ko).includes('sentence-furigana'))
  assert.deepEqual(
    markers(ko),
    markers(ja).filter((m) => !JAPANESE_ONLY_MARKERS.includes(m))
  )
})

test('the debug summary names the language beside the OCR engine', () => {
  assert.match(
    debugMarkdown({ ocr: { selected: 'ppocr' }, settings: { language: 'ko' } }),
    /\*\*OCR engine:\*\* ppocr, \*\*language:\*\* ko/
  )
  assert.match(debugMarkdown({ ocr: { selected: 'ppocr' }, settings: {} }), /\*\*language:\*\* ja/)
  assert.match(debugMarkdown({}), /\*\*language:\*\* unknown/)
})
