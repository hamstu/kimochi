/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
// The engine choosers (Settings → OCR & Overlay, Settings → Dictionary): a list that only views,
// and a panel whose "Use <name>" makes the viewed engine active. ui/engine-chooser.ts holds the
// decisions; the components are checked for wiring them that way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from './load.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => readFile(path.join(root, file), 'utf8')

const { listKeyTarget, activateLabel, ocrUseAction, dictionaryUseAction } = await load('engine-chooser.ts')
const { OCR_MODES } = await load('settings.ts')

const CHOOSERS = ['frontend/panels/settings/EngineChooser.tsx', 'frontend/panels/settings/DictionaryChooser.tsx']

test('the arrow keys, Home and End move the highlight; Enter and Space are not moves', () => {
  assert.equal(listKeyTarget('ArrowDown', 0, 4), 1)
  assert.equal(listKeyTarget('ArrowDown', 3, 4), 3, 'stops at the last engine')
  assert.equal(listKeyTarget('ArrowUp', 2, 4), 1)
  assert.equal(listKeyTarget('ArrowUp', 0, 4), 0, 'stops at the first engine')
  assert.equal(listKeyTarget('Home', 3, 4), 0)
  assert.equal(listKeyTarget('End', 0, 4), 3)
  for (const key of ['Enter', ' ', 'Tab', 'a', 'ArrowLeft']) assert.equal(listKeyTarget(key, 1, 4), null, key)
  assert.equal(listKeyTarget('ArrowDown', 0, 0), null, 'an empty list has nowhere to go')
})

test('the panel offers "Use <name>"', () => {
  assert.equal(activateLabel('Google Lens'), 'Use Google Lens')
  assert.equal(activateLabel('Built-in Yomitan'), 'Use Built-in Yomitan')
})

test('the OCR panel: Active, Confirming, Use, or Use disabled for an engine that cannot run', () => {
  assert.equal(ocrUseAction({ inUse: true, pending: false, selectable: true }), 'active')
  assert.equal(ocrUseAction({ inUse: false, pending: true, selectable: true }), 'pending')
  assert.equal(ocrUseAction({ inUse: false, pending: false, selectable: true }), 'use')
  assert.equal(ocrUseAction({ inUse: false, pending: false, selectable: false }), 'unavailable')
  // Shown as in use even when this computer could not choose it now (cloud without its key).
  assert.equal(ocrUseAction({ inUse: true, pending: false, selectable: false }), 'active')
})

test('the dictionary panel: the download leads until the engine is ready', () => {
  const at = (download, extra = {}) => dictionaryUseAction({ inUse: false, pending: false, download, ...extra })
  assert.equal(at('ready'), 'use')
  assert.equal(at(null), 'use', 'nothing to download (an older backend, the Yomitan API without a status)')
  assert.equal(at('absent'), 'download')
  for (const state of ['downloading', 'verifying', 'paused', 'failed']) assert.equal(at(state), 'resume', state)
  assert.equal(at('absent', { inUse: true }), 'active')
  assert.equal(at('downloading', { pending: true }), 'pending')
})

test('a row only views: the listbox selection is the viewed engine, never a choice', async () => {
  for (const file of CHOOSERS) {
    const source = await read(file)
    assert.ok(source.includes('role="listbox"') && source.includes('role="option"'), `${file} lost its listbox semantics`)
    assert.ok(source.includes('aria-selected={viewed}'), `${file}: aria-selected no longer tracks the viewed engine`)
    assert.ok(source.includes("aria-current={inUse ? 'true' : undefined}"), `${file}: the engine in use is not aria-current`)
    assert.ok(source.includes('onFocus={onView}'), `${file}: focusing a row no longer views it`)
    assert.ok(
      source.includes('onClick={(event) => event.currentTarget.focus()}'),
      `${file}: clicking a row does more than view it`
    )
    assert.ok(!/onPick|engine-item-radio/.test(source), `${file} still picks from the row, or draws the radio`)
    assert.ok(source.includes('listKeyTarget('), `${file} moves the highlight its own way`)
    // Enter and Space are swallowed (no scroll), not turned into a choice.
    assert.match(
      source,
      /if \(event\.key === 'Enter' \|\| event\.key === ' '\) \{\s*event\.preventDefault\(\)\s*return\s*\}/,
      `${file}: Enter or Space on a row does more than view`
    )
    assert.ok(source.includes('{inUse && <InUseCheck />}'), `${file}: the engine in use has no check mark`)
    assert.ok(source.includes('activateLabel(info.name)'), `${file}: the panel no longer offers "Use <name>"`)
  }
  const css = await read('frontend/panels/settings/engine-chooser.css')
  assert.ok(css.includes('.engine-item-check') && css.includes('var(--k-ok-text)'), 'the in-use check is not green')
  assert.ok(!css.includes('engine-item-radio'), 'the radio dots are still styled')
})

test('"Use <name>" is the only way to choose, and it is the panel\'s', async () => {
  const ocr = await read('frontend/panels/settings/EngineChooser.tsx')
  assert.ok(ocr.includes('onUse={() => use(viewed)}'), 'the OCR panel does not choose the engine it shows')
  assert.match(ocr, /const use = \(mode: OcrMode\): void => \{[\s\S]*?engineSelectable\(engines\[mode\]\)[\s\S]*?choose\(mode\)/,
    'the OCR chooser no longer refuses an engine this computer cannot run, or skips useEngineSelection')
  assert.ok(ocr.includes("disabled={action === 'unavailable'}"), 'an engine that cannot run offers an enabled Use')
  assert.ok(ocr.includes('aria-describedby={action'), 'the disabled Use does not point at its reason')
  const dictionary = await read('frontend/panels/settings/DictionaryChooser.tsx')
  assert.ok(dictionary.includes('onUse={() => use(viewed)}'), 'the dictionary panel does not choose the engine it shows')
  assert.match(dictionary, /const use = \(engine: DictionaryEngine\): void => \{[\s\S]*?onChoose\(engine\)/)
  // Choosing the Yomitan API ("Use Yomitan API", or the sidebar's picker) checks that it answers,
  // and opens its wizard only if it has not within the grace period: both go through
  // useDictionarySwitch, and both render the wizard it opens.
  const hook = await read('frontend/panels/settings/useDictionarySwitch.ts')
  assert.match(hook, /if \(engine === 'custom-api'\) setVerifyingApi\(/, 'choosing the Yomitan API no longer checks it answers')
  assert.match(hook, /apiCheck\([\s\S]*?Date\.now\(\) >= deadline[\s\S]*?openSetup\(true\)/,
    'a Yomitan API that does not answer in time no longer opens its setup')
  for (const file of ['frontend/panels/settings/DictionaryTab.tsx', 'frontend/main/MainSidebar.tsx']) {
    const source = await read(file)
    assert.ok(source.includes("useDictionarySwitch('"), `${file} does not switch through useDictionarySwitch`)
    assert.ok(source.includes('<YomitanApiSetupDialog'), `${file} does not render the Yomitan API setup`)
  }
})

test('every engine has a picture, and every picture file exists', async () => {
  const source = await read('frontend/components/EngineIcon.tsx')
  for (const mode of Object.keys(OCR_MODES)) {
    assert.match(source, new RegExp(`\\n  ${mode}: \\{`), `OCR engine ${mode} has no picture`)
  }
  for (const engine of ['yomitan', "'custom-api'", 'hachidori', 'tenten']) {
    assert.match(source, new RegExp(`\\n  ${engine}: \\{`), `dictionary engine ${engine} has no picture`)
  }
  const files = [...source.matchAll(/from '\.\.\/assets\/engine-icons\/([^']+)'/g)].map((match) => match[1])
  assert.ok(files.length >= 7, 'the logos are not imported from frontend/assets/engine-icons')
  for (const file of files) {
    const info = await stat(path.join(root, 'frontend/assets/engine-icons', file))
    assert.ok(info.size < 8 * 1024, `${file} is larger than a small icon should be`)
    if (file.endsWith('.svg')) {
      const svg = await read(`frontend/assets/engine-icons/${file}`)
      assert.ok(svg.includes('viewBox='), `${file} has no viewBox, so it will not scale`)
      assert.ok(!svg.includes('<text'), `${file} depends on an installed font`)
    }
  }
  const notice = await read('NOTICE')
  assert.ok(notice.includes('frontend/assets/engine-icons'), 'NOTICE does not list the engine icons')
})
