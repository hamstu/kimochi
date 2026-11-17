/**
 * The overlay's lookup key (`overlayLookupKey`): a modifier ("shift", "ctrl", "alt", "meta") or,
 * since #204, a mouse button ("MouseMiddle", "MouseBack", "MouseForward", the names a mouse
 * shortcut is stored under). Held, it opens the gate on the overlay's words and looks them up.
 *
 * Native carries a held lookup button as Shift in every pointer sample (`spawn_cursor_poll`), so
 * the scan, the gate, the hook card and the pop-ups follow it with no change; what reads the
 * setting itself (labels, the settings preview, re-keying real moves) goes through here.
 * ui/overlay-hints.js keeps its own copy of `lookupKeyLabel` (it is loaded unbundled in tests);
 * scripts/lookup-key.test.mjs checks the two agree.
 */

export type LookupModifier = 'shift' | 'ctrl' | 'alt' | 'meta'
export type LookupButton = 'MouseMiddle' | 'MouseBack' | 'MouseForward'
export type LookupKey = LookupModifier | LookupButton

/**
 * What this platform does with a lookup button (`keys.lookupButtons` in the capabilities):
 * `consumed`, its press over Kimochi's text is kept from the game (Windows; macOS with
 * Accessibility); `needsAccessibility`, macOS without it, where the press also reaches the game;
 * `passthrough`, X11, read without a grab, so the press also reaches the game; `unsupported`,
 * Wayland, where no application may read buttons pressed over another's window.
 */
export type LookupButtonSupport = 'consumed' | 'needsAccessibility' | 'passthrough' | 'unsupported'

export const LOOKUP_BUTTONS: readonly LookupButton[] = ['MouseMiddle', 'MouseBack', 'MouseForward']

/** `MouseEvent.button` for each lookup button (middle 1, back 3, forward 4). */
const EVENT_BUTTON: Record<LookupButton, number> = { MouseMiddle: 1, MouseBack: 3, MouseForward: 4 }
/** `MouseEvent.buttons` bit for each (middle 4, back 8, forward 16). */
const BUTTONS_BIT: Record<LookupButton, number> = { MouseMiddle: 4, MouseBack: 8, MouseForward: 16 }

export function isLookupButton(key: unknown): key is LookupButton {
  return typeof key === 'string' && (LOOKUP_BUTTONS as readonly string[]).includes(key)
}

/** The lookup button for a `MouseEvent.button`, or null for left, right and anything else. */
export function lookupButtonFromEvent(button: number): LookupButton | null {
  return LOOKUP_BUTTONS.find((name) => EVENT_BUTTON[name] === button) ?? null
}

/** The `MouseEvent.buttons` bit a held lookup button sets, or 0 for a modifier. */
export function lookupButtonsBit(key: unknown): number {
  return isLookupButton(key) ? BUTTONS_BIT[key] : 0
}

/**
 * The key that actually looks up here: the setting, except that a button where none can be read
 * (Wayland, or a choice synced from another machine) is Shift, as native reads it. Anything
 * unknown is Shift too.
 */
export function effectiveLookupKey(key: unknown, support: LookupButtonSupport | undefined): LookupKey {
  if (isLookupButton(key)) return support && support !== 'unsupported' ? key : 'shift'
  return lookupModifier(key)
}

/**
 * The modifier the dictionary hears for a lookup key: the key itself, or Shift for a button
 * (native sends a held button as Shift).
 */
export function lookupModifier(key: unknown): LookupModifier {
  return key === 'ctrl' || key === 'alt' || key === 'meta' ? key : 'shift'
}

/**
 * A lookup key as this platform labels it: macOS's key symbols and names (⇧ Shift, ⌘ Command),
 * words elsewhere, and the button's name for a mouse button.
 */
export function lookupKeyLabel(key: unknown, mac: boolean): string {
  switch (key) {
    case 'ctrl':
      return mac ? '⌃ Control' : 'Ctrl'
    case 'alt':
      return mac ? '⌥ Option' : 'Alt'
    case 'meta':
      return mac ? '⌘ Command' : 'Super'
    case 'MouseMiddle':
      return 'Middle Mouse'
    case 'MouseBack':
      return 'Mouse Back'
    case 'MouseForward':
      return 'Mouse Forward'
    default:
      return mac ? '⇧ Shift' : 'Shift'
  }
}

/** The label without macOS's symbol, for running text ("Set its lookup key to Control"). */
export function lookupKeyWord(key: unknown, mac: boolean): string {
  return lookupKeyLabel(key, mac).replace(/^[⇧⌃⌥⌘] /, '')
}

/**
 * The lookup key a key press records (`KeyboardEvent.key`): one of the modifiers alone, since the
 * key is held while reading. Command only on a Mac (elsewhere the Windows / Super key opens the
 * system's menus). `null` for anything else.
 */
export function lookupModifierFromKey(key: string, mac: boolean): LookupModifier | null {
  switch (key) {
    case 'Shift':
      return 'shift'
    case 'Control':
      return 'ctrl'
    case 'Alt':
      return 'alt'
    case 'Meta':
      return mac ? 'meta' : null
    default:
      return null
  }
}
