import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const {
  SCAN_KEY,
  autoScanSkipped,
  autoScanStatus,
  engineName,
  recognising,
  scanFailed,
  scanOutcome,
  scanStarted
} = await load('scan-activity.ts')
const { ActivityFeed } = await load('activity.ts')
const { publishOcrResult } = await load('output.js')

const said = (post) => post && [post.text, post.tone]

test('engines are named as the settings name them', () => {
  assert.equal(engineName('meikiocr'), 'MeikiOCR')
  assert.equal(engineName('local'), 'MeikiOCR')
  assert.equal(engineName('cloud'), 'Cloud OCR')
  assert.equal(engineName('googlelens'), 'Google Lens')
  assert.equal(engineName('nonsense'), 'the OCR engine')
  assert.deepEqual(said(recognising('mangaocr')), ['Recognising with Manga OCR…', 'busy'])
})

test('a scan outcome says how many lines the Log gained, or why none', () => {
  assert.deepEqual(said(scanOutcome({ lines: 3, duplicate: false })), ['Added 3 lines', 'ok'])
  assert.deepEqual(said(scanOutcome({ lines: 1, duplicate: false })), ['Added 1 line', 'ok'])
  assert.deepEqual(said(scanOutcome({ lines: 0, duplicate: true })), [
    'Same text as before, not added',
    'info'
  ])
  assert.deepEqual(said(scanOutcome({ lines: 0, duplicate: false })), ['Nothing recognised', 'warn'])
  assert.deepEqual(said(scanOutcome(null)), ['Nothing recognised', 'warn'])
  // The automatic loop reading nothing new is its normal case.
  assert.deepEqual(said(scanOutcome(null, { auto: true })), ['No new text', 'info'])
  assert.equal(scanOutcome(null).key, SCAN_KEY)
})

test('native error prefixes become plain sentences with the right tone', () => {
  assert.deepEqual(said(scanFailed('busy: a capture is already running; retry shortly', 'capture', 'cloud')), [
    'Scan skipped: a capture is already running',
    'info'
  ])
  assert.deepEqual(
    said(scanFailed(new Error('permission: Screen Recording is off'), 'capture', 'cloud')),
    ['Screen capture is not permitted: Screen Recording is off', 'error']
  )
  assert.deepEqual(
    said(scanFailed('gone: pick-again: that shared source has closed', 'capture', 'cloud')),
    ['The source is gone: that shared source has closed', 'warn']
  )
  assert.deepEqual(
    said(scanFailed('gone: hidden: Window is minimized; restore it before capturing.', 'capture', 'cloud')),
    ['The window is out of view: Window is minimized; restore it before capturing.', 'warn']
  )
  assert.deepEqual(
    said(scanFailed('gone: that frame has been replaced; capture again before running OCR', 'recognise', 'cloud')),
    ['Scan discarded: the captured frame was replaced', 'warn']
  )
  assert.deepEqual(said(scanFailed('gone: cannot publish an evicted capture frame', 'publish', 'cloud')), [
    'Scan discarded: the captured frame was replaced',
    'warn'
  ])
  assert.deepEqual(said(scanFailed('No source selected', 'capture', 'cloud')), [
    'Choose a source before scanning',
    'warn'
  ])
  assert.deepEqual(said(scanFailed('native: OCR HTTP 429: quota exceeded', 'recognise', 'cloud')), [
    'OCR failed: OCR HTTP 429: quota exceeded',
    'error'
  ])
  const signedOut =
    'Kimochi cloud OCR needs a Kimochi account. Sign in from Settings → Account, or choose another OCR engine in Settings → OCR & Overlay.'
  assert.deepEqual(said(scanFailed(`native: ${signedOut}`, 'recognise', 'cloud')), [signedOut, 'warn'])
  const signedOutRemotely =
    'Kimochi signed out of your account on this computer because the server no longer accepts it. Sign in again from Settings → Account.'
  assert.deepEqual(said(scanFailed(`native: ${signedOutRemotely}`, 'recognise', 'cloud')), [signedOutRemotely, 'warn'])
  assert.deepEqual(said(scanFailed('native: capture failed', 'capture', 'cloud')), [
    'Capture failed: capture failed',
    'error'
  ])
})

test('an engine held back by its model says where the model stands', () => {
  const failed = (reason, mode = 'meikiocr') =>
    said(scanFailed(`${engineName(mode)} is not ready: ${reason}`, 'recognise', mode))
  assert.deepEqual(failed('Downloading model… 42%'), [
    'MeikiOCR model is still downloading (42%)',
    'warn'
  ])
  assert.deepEqual(failed('Verifying model…', 'mangaocr'), [
    'Manga OCR model is still being verified',
    'warn'
  ])
  assert.deepEqual(failed('Model not downloaded'), ['MeikiOCR model is not downloaded yet', 'warn'])
  assert.deepEqual(failed('Model download paused'), ['MeikiOCR model download is paused', 'warn'])
  assert.deepEqual(failed('Model download failed: HTTP 503'), [
    'MeikiOCR model download failed: HTTP 503',
    'error'
  ])
  assert.deepEqual(failed('the runtime is missing'), [
    'MeikiOCR is not available: the runtime is missing',
    'warn'
  ])
  assert.deepEqual(said(scanFailed('OneOCR is available on Windows only.', 'recognise', 'oneocr')), [
    'OneOCR is available on Windows only',
    'warn'
  ])
})

test('the automatic loop reports state changes and only the skips that end a recognition', () => {
  assert.deepEqual(said(autoScanStatus('running', 'Automatic scanning started.')), ['Auto-scan on', 'info'])
  assert.deepEqual(said(autoScanStatus('idle', 'Automatic scanning stopped.')), ['Auto-scan off', 'info'])
  assert.equal(autoScanStatus('suspended', '').tone, 'warn')
  assert.deepEqual(said(autoScanStatus('unavailable', 'No observer here.')), [
    'Auto-scan unavailable: No observer here.',
    'warn'
  ])
  assert.equal(autoScanStatus('paused', ''), null)
  for (const reason of ['locked', 'backoff', 'duplicate-submission', 'suspended', 'unavailable'])
    assert.equal(autoScanSkipped(reason), null, reason)
  assert.deepEqual(said(autoScanSkipped('stale-generation')), [
    'Scan discarded: the source changed while it was running',
    'warn'
  ])
  assert.equal(autoScanSkipped('superseded').key, SCAN_KEY)
})

test('a scan reads as one row that settles into its outcome', () => {
  const feed = new ActivityFeed()
  feed.post(scanStarted())
  feed.post(recognising('meikiocr'))
  assert.equal(feed.entries().length, 1)
  assert.equal(feed.latest().text, 'Recognising with MeikiOCR…')
  feed.post(scanFailed('MeikiOCR is not ready: Downloading model… 42%', 'recognise', 'meikiocr'))
  assert.deepEqual(
    feed.entries().map((entry) => [entry.text, entry.tone]),
    [['MeikiOCR model is still downloading (42%)', 'warn']]
  )
})

test('publishing reports how many lines the Log will show', async () => {
  const reports = []
  const onPublication = (report) => reports.push(report)
  const group = (id, text) => ({ id, text, orientation: 'horizontal' })
  await publishOcrResult(
    { geometry: false, fullText: 'あ\nい', textAnnotations: [], groups: [group('a', 'あ'), group('b', 'い'), group('c', ' ')] },
    { onPublication }
  )
  await publishOcrResult({ geometry: false, fullText: 'う', textAnnotations: [], groups: [] }, { onPublication })
  await publishOcrResult({ geometry: false, fullText: '  ', textAnnotations: [], groups: [] }, { onPublication })
  assert.deepEqual(reports, [
    { lines: 2, duplicate: false },
    { lines: 1, duplicate: false },
    { lines: 0, duplicate: false }
  ])
})
