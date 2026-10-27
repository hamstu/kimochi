/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * A controller driving the region editor (ui/region-select.js): the sticks move the box's corners,
 * the Select button saves it and Back cancels (the buttons from `controllerButtons`).
 *
 * Under Gamescope the controller is Steam's until Kimochi takes it, so this turns controller
 * navigation on for as long as the editor is open, renewing it like the controller menu does
 * (ui/overlay.js): native then holds Steam off the controller, sends `controller-nav` with the
 * sticks and presses, and `controller-nav-cancel` when Steam's own buttons take over. Elsewhere
 * nothing is taken: the native `gamepad` state every window gets is read instead.
 */
import { DEFAULT_BUTTONS } from './controller-input.js'

/** How often controller navigation is renewed while the editor is open (see ui/overlay.js). */
const RENEW_MS = 500
/** Below this a stick read from raw `gamepad` state is at rest. */
const DEADZONE = 0.25

/** The Select and Back buttons from `controllerButtons`; a missing entry keeps its default. */
export function padButtons(stored) {
  const pick = (key) => (stored && key in stored ? stored[key] : DEFAULT_BUTTONS[key])
  return { confirm: pick('confirm'), back: pick('back') }
}

function rest(value) {
  return Number.isFinite(value) && Math.abs(value) >= DEADZONE ? value : 0
}

/**
 * Feed `selector` from the controller until the returned function is called.
 *
 * @param {object} selector a running RegionSelect
 * @param {{native: object, gamescope: boolean, buttons: {confirm: number|null, back: number|null},
 *   log?: Function, setInterval?: Function, clearInterval?: Function}} options
 * @returns {Promise<() => Promise<void>>}
 */
export async function startRegionPad(selector, { native, gamescope, buttons, log = () => {}, ...timers }) {
  const every = timers.setInterval ?? globalThis.setInterval.bind(globalThis)
  const stopEvery = timers.clearInterval ?? globalThis.clearInterval.bind(globalThis)
  const press = (pressed) => {
    if (Number.isInteger(buttons.back) && pressed.includes(buttons.back)) selector.cancel()
    else if (Number.isInteger(buttons.confirm) && pressed.includes(buttons.confirm)) selector.confirm()
  }
  const stops = []

  if (gamescope) {
    stops.push(
      await native.listen('controller-nav', ({ payload }) => {
        if (!selector.active) return
        selector.sticks(payload?.stick, payload?.rstick)
        if (payload?.pressed?.length) press(payload.pressed)
      })
    )
    // Steam's own buttons, or the controller going away: give everything back.
    stops.push(await native.listen('controller-nav-cancel', () => selector.cancel()))
    const take = async () => {
      try {
        const result = await native.controllerNav(true)
        if (result?.gamescopeInput === false) log({ check: 'region-pad-lease-failed', error: result.error })
      } catch (error) {
        log({ check: 'region-pad-lease-failed', error: String(error?.message ?? error) })
      }
    }
    // Stopped in reverse: the renewal first, so it cannot take the controller back after.
    stops.push(() => native.controllerNav(false))
    await take()
    const timer = every(() => void take(), RENEW_MS)
    stops.push(() => stopEvery(timer))
  } else {
    // A button already down when the editor opened (the one that opened it, say) is not a press.
    let held = null
    stops.push(
      await native.listen('gamepad', ({ payload }) => {
        if (!selector.active || payload?.activeGamepadIndex == null) return
        const axes = payload.axisStates ?? []
        selector.sticks({ x: rest(axes[0]), y: rest(axes[1]) }, { x: rest(axes[2]), y: rest(axes[3]) })
        const states = payload.buttonStates ?? []
        const pressed = held ? states.flatMap((down, index) => (down && !held[index] ? [index] : [])) : []
        held = states
        if (pressed.length) press(pressed)
      })
    )
  }

  return async () => {
    for (const stop of stops.splice(0).reverse()) {
      try {
        await stop()
      } catch (error) {
        log({ check: 'region-pad-stop-failed', error: String(error?.message ?? error) })
      }
    }
  }
}

export default { startRegionPad, padButtons }
