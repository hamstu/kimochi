import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { ForegroundTracker, isSourceInForeground, getScannedAppName, shouldShowOverlay } =
  await load('foreground.ts')

const window_ = { kind: 'window', app: 'Safari', name: 'A page' }
const display = { kind: 'display', name: 'Display 1' }

test('our own windows never become the effective foreground app', () => {
  const tracker = new ForegroundTracker(['Kimochi Next POC'])
  tracker.note('Safari')
  assert.equal(tracker.current, 'Safari')

  // Clicking the controller must not blank the text the user is about to read.
  tracker.note('Kimochi Next POC')
  assert.equal(tracker.current, 'Safari')
  assert.equal(shouldShowOverlay('Safari', tracker.current), true)

  tracker.note('Terminal')
  assert.equal(tracker.current, 'Terminal')
})

test('before any focus signal arrives, text is shown rather than hidden', () => {
  const tracker = new ForegroundTracker()
  assert.equal(tracker.current, null)
  assert.equal(shouldShowOverlay('Safari', tracker.current), true)
  assert.equal(isSourceInForeground(window_, tracker.current), true)
})

test('a window source is hidden only once a different app is genuinely in front', () => {
  assert.equal(isSourceInForeground(window_, 'Safari'), true)
  assert.equal(isSourceInForeground(window_, 'Terminal'), false)
  assert.equal(shouldShowOverlay('Safari', 'Terminal'), false)
})

test('a screen source stays in the foreground whatever is focused', () => {
  assert.equal(isSourceInForeground(display, 'Terminal'), true)
  assert.equal(isSourceInForeground(undefined, 'Terminal'), true)
})

test('a window scan is attributed to the captured window, not to the focused app', () => {
  // The scan was triggered from our own controller, so focus is meaningless here.
  assert.equal(getScannedAppName(window_, 'Kimochi Next POC'), 'Safari')
  assert.equal(getScannedAppName(window_, null), 'Safari')
  // A screen capture has no owning app, so the focused app is the best label.
  assert.equal(getScannedAppName(display, 'Safari'), 'Safari')
})

test('both source shapes are understood, native and Electron', () => {
  assert.equal(getScannedAppName({ type: 'window', appName: 'Safari' }, null), 'Safari')
  assert.equal(isSourceInForeground({ type: 'screen' }, 'Terminal'), true)
})
