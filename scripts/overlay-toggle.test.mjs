import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { isOverlayTextVisible, nextOverlayToggle, SETTINGS_DEFAULTS } = await load('settings.ts')

/** The state a fresh profile starts in: overlay mode off, session flag on. */
const fresh = {
  liveOverlayEnabled: SETTINGS_DEFAULTS.liveOverlayEnabled,
  textOverlayVisible: true
}

const apply = (state) => {
  const next = nextOverlayToggle(state)
  return { ...next, visible: isOverlayTextVisible(next.liveOverlayEnabled, next.textOverlayVisible) }
}

test('both gates are required, so neither flag alone describes the overlay', () => {
  assert.equal(isOverlayTextVisible(true, true), true)
  assert.equal(isOverlayTextVisible(false, true), false)
  assert.equal(isOverlayTextVisible(true, false), false)
  assert.equal(isOverlayTextVisible(false, false), false)
})

test('a fresh profile draws nothing until something turns overlay mode on', () => {
  assert.equal(fresh.liveOverlayEnabled, false, 'liveOverlayEnabled still defaults to off')
  assert.equal(isOverlayTextVisible(fresh.liveOverlayEnabled, fresh.textOverlayVisible), false)
})

test('one press of the remote toggle actually shows text on a fresh profile', () => {
  // The regression: flipping only the session flag left a switch that read as on
  // while the render gate stayed shut, so the user had to find the Settings
  // switch before the remote control meant anything.
  const after = apply(fresh)
  assert.equal(after.visible, true)
  assert.equal(after.liveOverlayEnabled, true)
  assert.equal(after.textOverlayVisible, true)
})

test('the toggle is never decorative: every press changes what is drawn', () => {
  let state = fresh
  let visible = isOverlayTextVisible(state.liveOverlayEnabled, state.textOverlayVisible)
  for (let press = 0; press < 6; press++) {
    const after = apply(state)
    assert.notEqual(after.visible, visible, `press ${press + 1} changed nothing`)
    state = { liveOverlayEnabled: after.liveOverlayEnabled, textOverlayVisible: after.textOverlayVisible }
    visible = after.visible
  }
})

test('turning it off leaves the persisted preference alone', () => {
  // Settings shows `liveOverlayEnabled`; hiding text for a moment from the remote
  // must not silently rewrite it, or the two surfaces disagree.
  const on = { liveOverlayEnabled: true, textOverlayVisible: true }
  const off = nextOverlayToggle(on)
  assert.equal(off.liveOverlayEnabled, true)
  assert.equal(off.textOverlayVisible, false)
  assert.equal(isOverlayTextVisible(off.liveOverlayEnabled, off.textOverlayVisible), false)
})

test('turning it back on does not need Settings touched again', () => {
  const hidden = { liveOverlayEnabled: true, textOverlayVisible: false }
  const shown = apply(hidden)
  assert.equal(shown.visible, true)
  assert.equal(shown.liveOverlayEnabled, true)
})

test('a profile with overlay mode off but text shown is repaired by one press', () => {
  // Reachable by switching overlay mode off in Settings while the session flag
  // is still on: the predicate says hidden, and one press must show it.
  const inconsistent = { liveOverlayEnabled: false, textOverlayVisible: true }
  assert.equal(
    isOverlayTextVisible(inconsistent.liveOverlayEnabled, inconsistent.textOverlayVisible),
    false
  )
  assert.equal(apply(inconsistent).visible, true)
})
