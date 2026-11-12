/**
 * A settings file this build can't fully use must never take a window down.
 *
 * 0.8.1 drew a gray main window over `ocrMode: "screenai"`, written by 0.9.0: the value went
 * straight into a table lookup in the render path. Settings now read every closed-set value and
 * every field's type against what this build knows (`withDefaults`), and a window that still
 * fails to render explains itself (`WindowErrorBoundary`) instead of going blank.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { load } from './load.mjs'

const { withDefaults, SETTINGS_DEFAULTS, ocrModeInfo } = await load('settings.ts')

test('an OCR engine this build does not know reads as the default engine', () => {
  assert.equal(withDefaults('ocrMode', 'futureocr'), SETTINGS_DEFAULTS.ocrMode)
  assert.equal(withDefaults('ocrMode', 42), SETTINGS_DEFAULTS.ocrMode)
  // Known engines and the old migrations are untouched.
  assert.equal(withDefaults('ocrMode', 'screenai'), 'screenai')
  assert.equal(withDefaults('ocrMode', 'local'), 'meikiocr')
})

test('other closed-set settings fall back the same way', () => {
  assert.equal(withDefaults('appearance', 'neon'), SETTINGS_DEFAULTS.appearance)
  assert.equal(withDefaults('appearance', 'dark'), 'dark')
  assert.equal(withDefaults('interfaceScale', 'huge'), SETTINGS_DEFAULTS.interfaceScale)
})

test('a value of the wrong type reads as the default', () => {
  assert.equal(withDefaults('overlayOpacity', '80'), SETTINGS_DEFAULTS.overlayOpacity)
  assert.equal(withDefaults('overlayOpacity', Number.NaN), SETTINGS_DEFAULTS.overlayOpacity)
  assert.equal(withDefaults('soundEffects', 'yes'), SETTINGS_DEFAULTS.soundEffects)
  assert.deepEqual(withDefaults('scannedTextHistory', { not: 'a list' }), SETTINGS_DEFAULTS.scannedTextHistory)
  assert.deepEqual(withDefaults('cardTags', 'tags'), SETTINGS_DEFAULTS.cardTags)
  assert.equal(withDefaults('overlayOpacity', 55), 55)
  assert.equal(withDefaults('overlayHoverLookup', 'yes'), false)
  assert.equal(withDefaults('overlayHoverLookup', true), true)
})

test("an object setting keeps its good fields and drops only the broken one", () => {
  const read = withDefaults('cardScreenshot', { enabled: 'yes', field: 'Picture', kept: 120 })
  assert.equal(read.enabled, SETTINGS_DEFAULTS.cardScreenshot.enabled)
  assert.equal(read.field, 'Picture')
  assert.equal(read.kept, 120)
})

test('null still means "none" where a setting uses it', () => {
  const read = withDefaults('gamepadSettings', { enabled: true, lookupButton: null })
  assert.equal(read.lookupButton, null)
  assert.equal(read.enabled, true)
})

test('an unknown engine key still has a name and an icon kind', () => {
  assert.equal(ocrModeInfo('futureocr').name, 'futureocr')
  assert.equal(ocrModeInfo('futureocr').runs, 'local')
  assert.equal(ocrModeInfo('googlelens').name, 'Google Lens')
})

test('a window whose content throws shows what happened instead of going blank', async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../frontend/shell/WindowErrorBoundary.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    jsx: 'automatic',
    // Nothing native runs: reporting is stubbed below, and the version is only read on Copy.
    external: ['@tauri-apps/api/*', 'react', 'react/jsx-runtime'],
    plugins: [
      {
        name: 'stub-report',
        setup(b) {
          b.onResolve({ filter: /reportErrors$/ }, () => ({ path: 'report', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'export const reportError = (...a) => globalThis.__reported.push(a)',
            loader: 'js'
          }))
        }
      }
    ]
  })
  globalThis.__reported = []
  const code = Buffer.from(outputFiles[0].contents).toString('utf8')
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const { writeFile, rm } = await import('node:fs/promises')
  // Written beside the tests so `react` resolves from the repo's node_modules.
  const file = `${dir}.window-error-boundary.test-build.mjs`
  await writeFile(file, code)
  try {
    const { WindowErrorBoundary } = await import(`${file}?${Date.now()}`)
    const failure = new TypeError("undefined is not an object (evaluating 'Is[e].name')")
    const boundary = new WindowErrorBoundary({ window: 'log', children: 'content' })
    assert.equal(boundary.render(), 'content', 'renders its children while nothing failed')

    boundary.state = { ...boundary.state, ...WindowErrorBoundary.getDerivedStateFromError(failure) }
    boundary.componentDidCatch(failure, { componentStack: '\n    at MainSidebar\n    at MainPanel' })
    const shown = JSON.stringify(boundary.render())
    assert.match(shown, /couldn.*t load/)
    assert.match(shown, /Is\[e\]\.name/, 'the error itself is on screen')
    assert.match(shown, /Reload window/)
    assert.match(shown, /Copy details/)
    assert.equal(globalThis.__reported.length, 1, 'reported to the diagnostics record')
    assert.equal(globalThis.__reported[0][0], 'log')
    assert.match(String(globalThis.__reported[0][2].stack), /MainSidebar/)
  } finally {
    await rm(file, { force: true })
  }
})
