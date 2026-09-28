/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * When scanned text should be on screen, and when the overlay should scan.
 *
 * Scanned text is a copy of what is on another window, drawn over it. Everything here
 * is about the moment that stops being true — the window goes behind something, is
 * minimised, or closes — because the copy then sits over nothing, and its click
 * targets sit over nothing too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { shouldShowScannedText, ForegroundTracker } = await load('foreground.ts')
const { overlayTextChange } = await load('settings.ts')
const { toOverlayLocal } = await load('geometry.ts')

const WINDOW = { kind: 'window', appName: 'OpenEmu', name: 'Chrono Trigger' }
const SCREEN = { kind: 'display', type: 'screen', name: 'Display 1' }
const here = { focused: true, present: true }
const gone = { focused: false, present: true }

test('text is shown while the captured window is the one in front', () => {
  assert.equal(shouldShowScannedText(WINDOW, here, 'OpenEmu', 'OpenEmu'), true)
})

test('text is hidden when another window comes in front', () => {
  assert.equal(shouldShowScannedText(WINDOW, gone, 'Safari', 'OpenEmu'), false)
})

test('another window of the same application is not the source', () => {
  // The whole reason this is a window-server question and not an application one: the
  // app name still matches, and the text still has to go.
  assert.equal(shouldShowScannedText(WINDOW, gone, 'OpenEmu', 'OpenEmu'), false)
})

test('a minimised or closed window hides its text even while nominally focused', () => {
  assert.equal(shouldShowScannedText(WINDOW, { focused: true, present: false }, 'OpenEmu', 'OpenEmu'), false)
})

test('hovering the text or clicking the dictionary does not hide it', () => {
  // Both make Kimochi frontmost. Native holds the previous answer while one of our own
  // windows is in front, so `focused` stays true — without that, the text would hide
  // itself the moment it was touched, taking the popup with it.
  const held = { focused: true, present: true, held: true }
  assert.equal(shouldShowScannedText(WINDOW, held, 'OpenEmu', 'OpenEmu'), true)
})

test('a held answer of "not focused" stays hidden', () => {
  const held = { focused: false, present: true, held: true }
  assert.equal(shouldShowScannedText(WINDOW, held, 'OpenEmu', 'OpenEmu'), false)
})

test('a screen capture keeps its documented behaviour and ignores window focus', () => {
  // There is no window whose focus could be lost. Applying window rules would blank a
  // whole-screen scan for no reason.
  assert.equal(shouldShowScannedText(SCREEN, gone, 'Safari', null), true)
  assert.equal(shouldShowScannedText(SCREEN, gone, 'Safari', 'Safari'), true)
})

test('a screen capture still follows the application it was attributed to', () => {
  assert.equal(shouldShowScannedText(SCREEN, here, 'Safari', 'OpenEmu'), false)
})

test('before native has answered, the application rules still decide', () => {
  // Blanking the text the reader asked for would be a worse guess than showing it.
  assert.equal(shouldShowScannedText(WINDOW, null, 'OpenEmu', 'OpenEmu'), true)
  assert.equal(shouldShowScannedText(WINDOW, null, 'Safari', 'OpenEmu'), false)
})

test('our own windows stay neutral in the fallback rules too', () => {
  const tracker = new ForegroundTracker()
  tracker.note('OpenEmu')
  tracker.note('Kimochi Next POC')
  assert.equal(tracker.current, 'OpenEmu')
  assert.equal(shouldShowScannedText(WINDOW, null, tracker.current, 'OpenEmu'), true)
})

// --- switching the overlay's text on -----------------------------------------------

test('switching the text on scans, so it does not switch on to nothing', () => {
  assert.equal(overlayTextChange(false, true, false), 'scan')
})

test('switching it off never scans', () => {
  assert.equal(overlayTextChange(true, false, false), 'idle')
  assert.equal(overlayTextChange(false, false, false), 'idle')
})

test('startup is not a transition', () => {
  // Both inputs are read once before the reader has touched anything.
  assert.equal(overlayTextChange(null, true, false), 'idle')
  assert.equal(overlayTextChange(null, false, false), 'idle')
})

test('one press cannot scan twice, however many channels report it', () => {
  // The session flag and the persisted preference arrive separately. The second report
  // sees the combined answer already true.
  assert.equal(overlayTextChange(false, true, false), 'scan')
  assert.equal(overlayTextChange(true, true, false), 'idle')
})

test('a scan already running satisfies the transition rather than starting another', () => {
  assert.equal(overlayTextChange(false, true, true), 'scan-pending')
})

// --- desktop points to overlay coordinates -----------------------------------------

test('the pointer is translated into the overlay window, never scaled', () => {
  assert.deepEqual(toOverlayLocal({ x: 2000, y: 500 }, { x: 1728, y: 0 }), { x: 272, y: 500 })
})

test('a display above or to the left has a negative origin', () => {
  assert.deepEqual(toOverlayLocal({ x: -800, y: -400 }, { x: -1440, y: -900 }), { x: 640, y: 500 })
})

test('backing scale does not enter into it', () => {
  // Desktop points and CSS pixels are the same unit on both a 1x and a Retina display,
  // which is why the overlay's own hit rectangles are computed the same way.
  const retina = toOverlayLocal({ x: 1900, y: 300 }, { x: 1728, y: 0 })
  const oneToOne = toOverlayLocal({ x: 1900, y: 300 }, { x: 1728, y: 0 })
  assert.deepEqual(retina, oneToOne)
})

test('with no overlay placed there is nowhere to translate into', () => {
  assert.equal(toOverlayLocal({ x: 10, y: 10 }, null), null)
})
