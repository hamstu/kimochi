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
const { SETTINGS_DEFAULTS, DEFAULT_VOICE_ID } = await import(pathToFileURL(outfile).href)
process.on('exit', () => {
  rm(outDir, { recursive: true, force: true }).catch(() => {})
})

/** Agreed with kimochi-native (COMMANDS.md) and kimochi-overlay (PARITY_CONTRACT.md §4.3). */
const AGREED = {
  overlayOpacity: 80,
  liveOverlayEnabled: false,
  scannedTextFontSize: 14,
  ocrMode: 'cloud',
  serverSettings: { mode: 'cloud' },
  audioSettings: { voiceId: 'j210dv0vWm7fCknyQpbA' },
  autoScanSettings: { enabled: false, triggerKeys: '', scanDelay: 500 },
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

test('serverSettings is an object, never a flat scalar', () => {
  // AudioPlayer and the OCR layer both read `serverSettings.mode`; a scalar would break both.
  assert.equal(typeof SETTINGS_DEFAULTS.serverSettings, 'object')
  assert.equal(SETTINGS_DEFAULTS.serverSettings.mode, 'cloud')
})

test('the Electron store defaults that carry over are unchanged', async (t) => {
  // The Electron app is a sibling checkout (`../kimochi`), absent on CI and fresh clones. Skip
  // rather than pass silently, and only when the file is missing: any other failure still fails.
  const electron = await readFile(
    new URL('../../kimochi/src/main/settings.ts', import.meta.url),
    'utf8'
  ).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (electron === null) {
    t.skip('sibling ../kimochi checkout not found; Electron store parity not checked')
    return
  }
  // Spot-check the values this experiment re-declares against their Electron source of truth.
  for (const [pattern, label] of [
    [/scannedTextFontSize:\s*14/, 'scannedTextFontSize'],
    [/pollInterval:\s*2000/, 'autoOCRSettings.pollInterval'],
    [/imageHashThreshold:\s*5/, 'autoOCRSettings.imageHashThreshold'],
    [/localOCRSimilarityThreshold:\s*0\.85/, 'autoOCRSettings.localOCRSimilarityThreshold'],
    [/adaptivePollMin:\s*500/, 'autoOCRSettings.adaptivePollMin'],
    [/adaptivePollMax:\s*5000/, 'autoOCRSettings.adaptivePollMax'],
    [/scanDelay:\s*500/, 'autoScanSettings.scanDelay'],
    [/webSocketUrl:\s*'ws:\/\/localhost:6677'/, 'texthookerSettings.webSocketUrl']
  ]) {
    assert.ok(pattern.test(electron), `${label} no longer matches src/main/settings.ts`)
  }
})
