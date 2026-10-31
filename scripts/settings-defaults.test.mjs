/**
 * The settings defaults are shared by three workstreams: the panels read them through
 * `frontend/bridge/settings.ts`, the overlay imports the same module, and the Rust store merges its
 * own copy on read. A silent disagreement would show up as a setting that appears to reset itself,
 * so this pins the values and checks the other copies that exist in the repo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

// The schema lives in one place for the whole app: ui/settings.ts, imported by the overlay and by
// the panels' settings client. Compile it here so this test checks the real module.
const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-settings-'))
const outfile = path.join(outDir, 'settings.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../ui/settings.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022'
})
const {
  SETTINGS_DEFAULTS,
  DEFAULT_VOICE_ID,
  DEFAULT_OVERLAY_STYLE,
  effectiveControllerButtons,
  hexToRgbTriplet,
  overlayStyleOf,
  resolveOverlayCardAppearance,
  sharedButtonActions,
  withDefaults
} = await import(pathToFileURL(outfile).href)
process.on('exit', () => {
  rm(outDir, { recursive: true, force: true }).catch(() => {})
})

/** Agreed with kimochi-native (COMMANDS.md). */
const AGREED = {
  overlayOpacity: 80,
  liveOverlayEnabled: false,
  scannedTextFontSize: 14,
  ocrMode: 'googlelens',
  serverSettings: { mode: 'cloud' },
  audioSettings: { voiceId: 'j210dv0vWm7fCknyQpbA' },
  autoScanSettings: { enabled: false, scanDelay: 500 },
  textOverlayGrouping: {
    enabled: false,
    proximityThreshold: 100,
    filterSmallText: true,
    filterSmallTextThreshold: 0.75
  },
  // The Electron keys are still here and still carry their Electron values; the
  // settling policy adds to them rather than replacing them. `observerMode` is
  // the one that changed meaning: it, not `localOCRGateEnabled`, now selects the
  // local gate, so an existing install with the gate stored off still gets one.
  autoOCRSettings: {
    // Retuned in version 2. The old 2000/500/5000 was inherited from Electron,
    // where the first pass was a whole-crop image hash; the local observer costs
    // a fraction of that, and the cost of being slow is a reader waiting seconds
    // for the next line. `version` is what lets a stored file inherit this.
    version: 2,
    pollInterval: 500,
    adaptivePollingEnabled: true,
    adaptivePollMin: 250,
    adaptivePollMax: 500,
    observerMode: 'text',
    watcher: 'auto',
    stableObservations: 2,
    maxCandidateAgeMs: 4000,
    minRequestSpacingMs: 1200,
    emptyObservationsToClear: 3,
    boxTolerancePx: 3,
    errorBackoffMs: 2000,
    maxErrorBackoffMs: 30000,
    maxConsecutiveErrors: 5,
    imageHashThreshold: 5,
    localOCRGateEnabled: false,
    localOCRSimilarityThreshold: 0.85
  },
  texthookerSettings: {
    copyToClipboard: false,
    sendToWebSocket: false,
    webSocketUrl: 'ws://localhost:6677'
  },
  gamepadSettings: { enabled: true, preferredGamepadIndex: undefined },
  scannedTextHistory: []
}

test('the shared schema matches the agreed contract', () => {
  for (const [key, expected] of Object.entries(AGREED)) {
    assert.deepEqual(SETTINGS_DEFAULTS[key], expected, `default for "${key}"`)
  }
  assert.equal(DEFAULT_VOICE_ID, 'j210dv0vWm7fCknyQpbA')
})

test('new installs default to Google Lens in the Rust store too', async () => {
  // The Rust store merges its own copy of the defaults; it must name the same engine.
  const rust = await readFile(new URL('../src-tauri/src/settings.rs', import.meta.url), 'utf8')
  assert.match(rust, /"ocrMode": "googlelens"/)
})

test('serverSettings is an object, never a flat scalar', () => {
  // AudioPlayer and the OCR layer both read `serverSettings.mode`; a scalar would break both.
  assert.equal(typeof SETTINGS_DEFAULTS.serverSettings, 'object')
  assert.equal(SETTINGS_DEFAULTS.serverSettings.mode, 'cloud')
})

test('controller buttons: new actions take their defaults, and the retired second Back is dropped', async () => {
  const older = { confirm: 0, back: 1, backAlt: 3, previousDefinition: 4, nextDefinition: 5 }
  const buttons = effectiveControllerButtons(older)
  assert.deepEqual(buttons, SETTINGS_DEFAULTS.controllerButtons)
  assert.equal('backAlt' in buttons, false)
  assert.equal(effectiveControllerButtons({ playAudio: null }).playAudio, null, 'unbound stays unbound')
  assert.deepEqual(sharedButtonActions({ ...buttons, playAudio: 0 }, 'confirm'), ['playAudio'])
  assert.deepEqual(sharedButtonActions(buttons, 'confirm'), [])
  // The overlay's own defaults are the same buttons.
  const { DEFAULT_BUTTONS } = await import('../ui/controller-input.js')
  assert.deepEqual(DEFAULT_BUTTONS, SETTINGS_DEFAULTS.controllerButtons)
})

test('overlay look: the default, the Rust store, and what a stored style reads as', async () => {
  assert.deepEqual(SETTINGS_DEFAULTS.overlayStyle, { color: '#3e63dd', appearance: 'app' })
  assert.deepEqual(DEFAULT_OVERLAY_STYLE, SETTINGS_DEFAULTS.overlayStyle)
  const rust = await readFile(new URL('../src-tauri/src/settings.rs', import.meta.url), 'utf8')
  assert.match(rust, /"overlayStyle": \{ "color": "#3e63dd", "appearance": "app" \}/)
  // A stored style is made whole, and anything this build cannot draw falls back to the default.
  assert.deepEqual(withDefaults('overlayStyle', undefined), DEFAULT_OVERLAY_STYLE)
  assert.deepEqual(withDefaults('overlayStyle', { color: '#0090FF' }), { color: '#0090ff', appearance: 'app' })
  assert.deepEqual(overlayStyleOf({ color: 'blue', appearance: 'sepia' }), DEFAULT_OVERLAY_STYLE)
  assert.deepEqual(overlayStyleOf({ appearance: 'light' }), { color: '#3e63dd', appearance: 'light' })
  assert.equal(hexToRgbTriplet('#3e63dd'), '62, 99, 221')
  assert.equal(hexToRgbTriplet('#fff'), null)
  assert.equal(hexToRgbTriplet(12), null)
})

test('overlay look: the cards follow Kimochi unless told otherwise', () => {
  const app = { color: '#3e63dd', appearance: 'app' }
  assert.equal(resolveOverlayCardAppearance(app, 'light', true), 'light')
  assert.equal(resolveOverlayCardAppearance(app, 'dark', false), 'dark')
  assert.equal(resolveOverlayCardAppearance(app, 'system', true), 'dark')
  assert.equal(resolveOverlayCardAppearance(app, 'system', false), 'light')
  assert.equal(resolveOverlayCardAppearance({ ...app, appearance: 'light' }, 'dark', true), 'light')
  assert.equal(resolveOverlayCardAppearance({ ...app, appearance: 'dark' }, 'light', false), 'dark')
})
