/**
 * The button test's raw view: what each controller sends, by raw code, whatever the standard layout
 * makes of it (native `gamepad.rs` `raw_activity`, or the browser's own indices). It tells
 * "nothing arrives" from "it arrives on another controller" from "it arrives but has no standard
 * button", which are the three ways a listed controller lights nothing up.
 */
import type { GamepadDevice } from '../../vendor/shared-types'

/**
 * One controller's current raw input, in words: `Button(3) → A`, `Button(12) (no button)`,
 * `Axis(1) −1`. `buttonName` names a standard index (`getButtonName`).
 */
export function describeRawInput(device: GamepadDevice, buttonName: (index: number) => string): string[] {
  const buttons = (device.rawButtons ?? []).map((button) =>
    button.standard === null ? `${button.code} (no button)` : `${button.code} → ${buttonName(button.standard)}`
  )
  const axes = (device.rawAxes ?? []).map((axis) => {
    const sign = axis.value < 0 ? '−' : '+'
    const label = axis.name && axis.name !== 'Unknown' ? `${axis.code} ${axis.name}` : axis.code
    return `${label} ${sign}${Math.abs(axis.value)}`
  })
  return [...buttons, ...axes]
}

function hasInput(device: GamepadDevice): boolean {
  return (device.rawButtons?.length ?? 0) > 0 || (device.rawAxes?.length ?? 0) > 0
}

/** The controller's name as the list shows it. */
export function gamepadLabel(device: GamepadDevice): string {
  return device.id.split('(')[0].trim() || `Gamepad ${device.index + 1}`
}

/**
 * Why the test may stay dark although input arrives, or null when nothing needs saying:
 * another controller than the active one is being pressed (a primary was chosen), or the active
 * one's buttons are all outside the standard layout.
 */
export function rawInputHint(gamepads: GamepadDevice[], activeIndex: number | null): string | null {
  const elsewhere = gamepads.find((device) => device.index !== activeIndex && hasInput(device))
  if (elsewhere) {
    return `Input is coming from ${gamepadLabel(elsewhere)}, which isn't the active controller. Choose Set as primary on it to use it.`
  }
  const active = gamepads.find((device) => device.index === activeIndex)
  const buttons = active?.rawButtons ?? []
  if (buttons.length > 0 && buttons.every((button) => button.standard === null)) {
    return "This controller's buttons don't match a standard layout, so Kimochi can't use them yet. Please save a debug bundle (Settings → About) and send it with your report."
  }
  return null
}
