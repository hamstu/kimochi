/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
// Settings → About → Debug info: the native report as Markdown (ui/debug-report.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { debugMarkdown, formatBytes } = await load('debug-report.ts')

const REPORT = {
  generatedAt: '2026-10-27T17:42:00Z',
  app: { version: '0.2.1', commit: '45eb5f1b55', build: 'release', tauri: '2.9.0', webview: '131.0.2903.70' },
  os: { name: 'windows', version: '10.0.26100', arch: 'x86_64', session: null },
  hardware: { cpu: 'AMD Ryzen 7 7800X3D', cores: 16, memoryBytes: 34359738368, gpus: ['NVIDIA GeForce RTX 4070 (driver 32.0.15.6094)'] },
  displays: [
    { id: 1, source_id: 'screen:1', bounds: { x: 0, y: 0, width: 2560, height: 1440 }, work_area: {}, scale_factor: 1.5 },
    { id: 2, source_id: 'screen:2', bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, work_area: {}, scale_factor: 1 }
  ],
  capture: { authorization: 'granted', windowCapture: true, excludesOwnWindows: true },
  ocr: {
    selected: 'meikiocr',
    engines: { meikiocr: { available: false, reason: 'The model could not load' }, googlelens: { available: true } },
    models: [{ engine: 'meikiocr', name: 'MeikiOCR', state: 'failed', message: 'checksum mismatch' }],
    cloudAccess: false
  },
  dictionary: { selected: 'yomitan', downloads: [{ engine: 'yomitan', name: 'Yomitan', version: '26.10.22.0', state: 'ready' }] },
  session: { sourceKind: 'window', sourceFocus: { focused: false, present: false, held: false, covered: false }, autoOcr: true, status: 'Paused: the game is minimised' },
  settings: { ocrMode: 'meikiocr', 'yomitanSettings.popupType': 'builtin' },
  windows: [{ label: 'welcome', visible: true, minimized: false, focused: true, bounds: { x: 10, y: 20, width: 720, height: 620 } }],
  verboseLogging: true,
  recentEvents: [{ check: 'ocr-failed', engine: 'meikiocr', error: 'model failed to load', at: 1 }]
}

test('the summary names what a bug report needs at a glance', () => {
  const md = debugMarkdown(REPORT)
  assert.match(md, /Kimochi 0\.2\.1 \(release, commit 45eb5f1b55\), Tauri 2\.9\.0, WebView 131\.0\.2903\.70/)
  assert.match(md, /\*\*OS:\*\* windows 10\.0\.26100 \(x86_64\)/)
  assert.match(md, /AMD Ryzen 7 7800X3D \(16 threads\), \*\*memory:\*\* 32 GB/)
  assert.match(md, /RTX 4070/)
  assert.match(md, /Display 1: 2560×1440 at \(0, 0\), scale 150%/)
  assert.match(md, /Display 2: 1920×1080 at \(-1920, 0\), scale 100%/)
  assert.match(md, /- meikiocr: unavailable \(The model could not load\)/)
  assert.match(md, /MeikiOCR: failed \(checksum mismatch\)/)
  assert.match(md, /Yomitan 26\.10\.22\.0: ready/)
  assert.match(md, /\*\*Source:\*\* window, behind, not on screen/)
  assert.match(md, /\*\*Auto OCR:\*\* on, status "Paused: the game is minimised"/)
  assert.match(md, /- welcome: shown, focused 720×620 at \(10, 20\)/)
  assert.match(md, /"check":"ocr-failed"/)
  assert.match(md, /<details>\n<summary>Recent events \(1\)<\/summary>/)
})

test('an empty or older report still formats, saying what it does not know', () => {
  const md = debugMarkdown({})
  assert.match(md, /Kimochi unknown/)
  assert.match(md, /- none reported/)
  assert.doesNotThrow(() => debugMarkdown({ displays: [{}], windows: [{}], ocr: { engines: { x: 'odd' } } }))
})

test('memory reads in whole gigabytes, small amounts in megabytes', () => {
  assert.equal(formatBytes(17179869184), '16 GB')
  assert.equal(formatBytes(512 * 1024 ** 2), '512 MB')
  assert.equal(formatBytes(null), 'unknown')
})
