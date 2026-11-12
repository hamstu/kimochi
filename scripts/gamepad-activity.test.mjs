import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

// The button test's raw view (frontend/panels/settings/gamepadActivity.ts), fed the device shape
// native sends (src-tauri/src/gamepad.rs `raw_activity`).
const { describeRawInput, rawInputHint, gamepadLabel } = await load(
  '../frontend/panels/settings/gamepadActivity.ts'
)

const NAMES = ['A', 'B', 'X', 'Y']
const name = (index) => NAMES[index] ?? `Button ${index}`

function pad(index, id, raw = {}) {
  return {
    index,
    id,
    connected: true,
    mapping: 'standard',
    buttons: 17,
    axes: 4,
    timestamp: 0,
    rawButtons: [],
    rawAxes: [],
    ...raw
  }
}

test('raw input names mapped and unmapped buttons and pushed axes', () => {
  const device = pad(0, 'Pad', {
    rawButtons: [
      { code: 'Button(1)', standard: 0 },
      { code: 'Button(20)', standard: null }
    ],
    rawAxes: [
      { code: 'Axis(1)', name: 'LeftStickY', value: -1 },
      { code: 'Switch(0)', name: 'Unknown', value: 0.5 }
    ]
  })
  assert.deepEqual(describeRawInput(device, name), [
    'Button(1) → A',
    'Button(20) (no button)',
    'Axis(1) LeftStickY −1',
    'Switch(0) +0.5'
  ])
  // A device from an older native build has no raw fields.
  const old = { ...device }
  delete old.rawButtons
  delete old.rawAxes
  assert.deepEqual(describeRawInput(old, name), [])
})

test('no hint while the active controller reads its presses, or nothing is pressed', () => {
  assert.equal(rawInputHint([pad(0, 'Pad')], 0), null)
  const pressed = pad(0, 'Pad', { rawButtons: [{ code: 'Button(1)', standard: 0 }] })
  assert.equal(rawInputHint([pressed, pad(1, 'Virtual')], 0), null)
  assert.equal(rawInputHint([], null), null)
})

test('input on a controller that is not the active one is pointed out', () => {
  const real = pad(1, 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c)', {
    rawButtons: [{ code: 'Button(1)', standard: 0 }]
  })
  const hint = rawInputHint([pad(0, 'Xbox 360 Controller for Windows'), real], 0)
  assert.match(hint, /Wireless Controller/)
  assert.match(hint, /Set as primary/)
  // An axis alone counts too (a pad whose D-pad is a hat).
  const hat = pad(1, 'Generic', { rawAxes: [{ code: 'Switch(1)', name: null, value: -1 }] })
  assert.match(rawInputHint([pad(0, 'Silent'), hat], 0), /Generic/)
})

test('an active controller whose presses have no standard button is pointed out', () => {
  const unmapped = pad(0, 'USB Joystick', {
    mappingSource: 'Driver',
    rawButtons: [{ code: 'Button(300)', standard: null }]
  })
  assert.match(rawInputHint([unmapped], 0), /standard layout/)
  // One mapped button among them: the test lights up, nothing to explain.
  const mixed = pad(0, 'USB Joystick', {
    rawButtons: [
      { code: 'Button(300)', standard: null },
      { code: 'Button(1)', standard: 0 }
    ]
  })
  assert.equal(rawInputHint([mixed], 0), null)
})

test('the label drops the vendor details in parentheses', () => {
  assert.equal(gamepadLabel(pad(0, 'Wireless Controller (STANDARD GAMEPAD)')), 'Wireless Controller')
  assert.equal(gamepadLabel(pad(2, '')), 'Gamepad 3')
})
