/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Controller and keyboard input for the overlay's controller mode, as commands.
 *
 * While the controller menu or word navigation is open, native stops dispatching gamepad
 * bindings and sends raw input instead: `controller-nav` events with the buttons pressed and
 * released since the last one, the buttons held, and both sticks (y positive is up), plus
 * `controller-key` events for the arrow keys, Return and Escape. This turns both into the few
 * things the overlay acts on, so the menu and the word cursor never look at buttons:
 *
 *   aim      the left stick's direction, for pointing at a radial menu item
 *   dir      one step up/down/left/right, from the D-pad, the left stick or the arrow keys;
 *            held D-pad and stick directions repeat, the way a game menu does
 *   step     previous/next definition, from the shoulder buttons
 *   confirm  A / Cross (south), or Return
 *   cancel   B / Circle (east) or Y / Triangle (north), or Escape
 *   menu     the controller menu's own button combination, pressed again
 *   scroll   the right stick's vertical deflection, for scrolling a dictionary popup
 *
 * Pure apart from the timers it is given, so it can be driven from a test.
 */

/** Standard (W3C) button indices, as native reports them. */
export const BUTTON = {
  south: 0,
  east: 1,
  west: 2,
  north: 3,
  lb: 4,
  rb: 5,
  up: 12,
  down: 13,
  left: 14,
  right: 15
}

/** The default command buttons; Settings → Shortcuts & Controls can rebind each one. */
export const DEFAULT_BUTTONS = {
  confirm: BUTTON.south,
  back: BUTTON.east,
  backAlt: BUTTON.north,
  previousDefinition: BUTTON.lb,
  nextDefinition: BUTTON.rb
}

const DPAD = {
  [BUTTON.up]: 'up',
  [BUTTON.down]: 'down',
  [BUTTON.left]: 'left',
  [BUTTON.right]: 'right'
}
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

/** How far the stick must lean before it counts as a direction, and how far back to release. */
export const STICK_PRESS = 0.6
export const STICK_RELEASE = 0.4
/** Held-direction repeat: a pause before the first repeat, then a steady rate. */
export const REPEAT_DELAY_MS = 380
export const REPEAT_RATE_MS = 110

const ZERO = { x: 0, y: 0 }

/** The stick's dominant direction, or null when it is not leaning far enough. */
export function stickDirection(stick, threshold = STICK_PRESS) {
  const { x, y } = stick ?? ZERO
  if (Math.hypot(x, y) < threshold) return null
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'right' : 'left'
  return y > 0 ? 'up' : 'down'
}

export class ControllerInput {
  /**
   * @param {(command: object) => void} emit
   * @param {{setTimeout?: Function, clearTimeout?: Function}} [timers]
   */
  constructor(emit, timers = {}) {
    this.emit = emit
    this.setTimeout = timers.setTimeout ?? globalThis.setTimeout.bind(globalThis)
    this.clearTimeout = timers.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
    /** The controller menu's button combination, so pressing it again closes the menu. */
    this.menuChord = []
    this.buttons = { ...DEFAULT_BUTTONS }
    this.held = new Set()
    this.stick = ZERO
    this.stickDir = null
    this.scroll = 0
    /** The direction currently repeating, and what is holding it. */
    this.repeating = null
    this.timer = null
  }

  setMenuChord(buttons) {
    this.menuChord = Array.isArray(buttons) ? buttons.filter(Number.isInteger) : []
  }

  /** The command buttons from settings; a missing entry keeps its default, `null` unbinds it. */
  setButtons(buttons) {
    this.buttons = { ...DEFAULT_BUTTONS, ...(buttons ?? {}) }
  }

  /** The command a button stands for, if any. */
  commandFor(button) {
    const { confirm, back, backAlt, previousDefinition, nextDefinition } = this.buttons
    if (button === confirm) return { type: 'confirm' }
    if (button === back || button === backAlt) return { type: 'cancel' }
    if (button === previousDefinition) return { type: 'step', delta: -1 }
    if (button === nextDefinition) return { type: 'step', delta: 1 }
    return null
  }

  /** Forget everything held: the mode closed, so nothing may repeat into the next one. */
  reset() {
    this.stopRepeat()
    this.held = new Set()
    this.stick = ZERO
    this.stickDir = null
    this.scroll = 0
  }

  /** A `controller-nav` payload. */
  nav(payload) {
    const pressed = payload?.pressed ?? []
    const released = payload?.released ?? []
    this.held = new Set(payload?.held ?? [])

    const chord = this.menuChord
    if (
      chord.length > 0 &&
      chord.every((button) => this.held.has(button)) &&
      pressed.some((button) => chord.includes(button))
    ) {
      this.emit({ type: 'menu' })
    } else {
      for (const button of pressed) {
        // A button that is part of the menu combination does nothing alone: it is usually
        // the first half of closing the menu, not a command.
        if (chord.length > 1 && chord.includes(button)) continue
        const command = this.commandFor(button)
        if (command) this.emit(command)
        else if (DPAD[button]) this.press(DPAD[button], `button:${button}`)
      }
    }
    for (const button of released) {
      if (this.repeating?.holder === `button:${button}`) this.stopRepeat()
    }

    const stick = payload?.stick ?? ZERO
    if (stick.x !== this.stick.x || stick.y !== this.stick.y) {
      this.stick = stick
      this.emit({ type: 'aim', x: stick.x, y: stick.y })
      // Hysteresis: lean past STICK_PRESS to press, come back inside STICK_RELEASE to let go,
      // so a stick resting near the threshold cannot chatter.
      const leaning = stickDirection(stick, this.stickDir ? STICK_RELEASE : STICK_PRESS)
      if (leaning !== this.stickDir) {
        if (this.repeating?.holder === 'stick') this.stopRepeat()
        this.stickDir = leaning
        if (leaning) this.press(leaning, 'stick')
      }
    }

    const scroll = payload?.rstick?.y ?? 0
    if (scroll !== this.scroll) {
      this.scroll = scroll
      this.emit({ type: 'scroll', y: scroll })
    }
  }

  /** A `controller-key` payload. Each key press is one step; the system repeats held keys. */
  key(payload) {
    if (payload?.type !== 'keydown') return
    const key = payload.key
    if (KEYS[key]) this.emit({ type: 'dir', dir: KEYS[key], source: 'key', repeat: false })
    else if (key === 'Enter') this.emit({ type: 'confirm' })
    else if (key === 'Escape') this.emit({ type: 'cancel' })
  }

  press(dir, holder) {
    this.stopRepeat()
    const source = holder === 'stick' ? 'stick' : 'dpad'
    this.emit({ type: 'dir', dir, source, repeat: false })
    this.repeating = { dir, holder }
    const tick = (delay) => {
      this.timer = this.setTimeout(() => {
        if (this.repeating?.dir !== dir || this.repeating.holder !== holder) return
        this.emit({ type: 'dir', dir, source, repeat: true })
        tick(REPEAT_RATE_MS)
      }, delay)
    }
    tick(REPEAT_DELAY_MS)
  }

  stopRepeat() {
    if (this.timer !== null) this.clearTimeout(this.timer)
    this.timer = null
    this.repeating = null
  }
}

export default { ControllerInput, BUTTON, stickDirection }
