/**
 * ADAPTED from `src/shared/defaults.ts` in the Electron app.
 * Deltas: only Scan, the controller menu, the menu's items (unbound by default) and Explain
 * (word and sentence) remain bindable (the radial menu reaches the rest), and gamepad bindings
 * are chords (`gamepadButtons`). Must match `default_hotkeys` and
 * `merged_hotkeys` in `src-tauri/src/settings.rs`, which is what the app actually loads.
 */
import { HotkeysSettings, HotkeyOverrides } from './shared-types'
import { RADIAL_ITEMS } from '@ui/radial-items.js'

/** Shift+F8/F9 on Windows and Linux (Ctrl makes visual novels skip text, #16); ⌘⇧8/⌘⇧Space on macOS. */
const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

export const DEFAULT_HOTKEYS: HotkeysSettings = {
  triggerScan: {
    name: 'Scan',
    accelerator: MAC ? 'CommandOrControl+Shift+8' : 'Shift+F8',
    description: 'Trigger OCR scan on current source',
    enabled: true,
    gamepadButtons: []
  },
  openControllerMenu: {
    name: 'Radial menu',
    accelerator: MAC ? 'CommandOrControl+Shift+Space' : 'Shift+F9',
    description: 'Open the radial menu over the game',
    enabled: true,
    // LS + RS: both stick clicks, which few games use together. A placeholder until the native
    // hotkeys load: on a Steam Deck the native default is the R4 back grip (settings.rs).
    gamepadButtons: [10, 11]
  },
  // The controller menu's items, each run without the menu by its own keys or buttons.
  ...Object.fromEntries(
    RADIAL_ITEMS.map((item) => [
      item.hotkey,
      { name: item.label, accelerator: '', description: item.description, enabled: true, gamepadButtons: [] }
    ])
  ),
  // Alt+X: X alone is Explain over a line in the Log, and a key games use.
  explainText: {
    name: 'Explain',
    accelerator: 'Alt+X',
    description: 'Explain the text on the overlay with AI, starting from the word you point at',
    enabled: true,
    gamepadButtons: []
  },
  // With Control too: the whole sentence, not the word pointed at. Not Shift: the lookup key.
  explainSentence: {
    name: 'Explain sentence',
    accelerator: 'Control+Alt+X',
    description: 'Explain the whole sentence on the overlay with AI, not one word in it',
    enabled: true,
    gamepadButtons: []
  }
}

/** A binding's chord: `gamepadButtons` when present (even null), else the legacy single button. */
export function gamepadChord(binding: { gamepadButtons?: number[] | null; gamepadButton?: number }): number[] {
  const buttons =
    binding.gamepadButtons !== undefined
      ? (binding.gamepadButtons ?? [])
      : binding.gamepadButton !== undefined
        ? [binding.gamepadButton]
        : []
  return [...new Set(buttons)].sort((a, b) => a - b)
}

// Merge default hotkeys with custom overrides. Unknown override keys are ignored, which retires
// the bindings of actions that are no longer bindable.
export function mergeHotkeysWithOverrides(overrides: HotkeyOverrides = {}): HotkeysSettings {
  const merged: HotkeysSettings = {}

  for (const [key, defaultHotkey] of Object.entries(DEFAULT_HOTKEYS)) {
    const override = overrides[key]
    const hasChord =
      override !== undefined && (override.gamepadButtons !== undefined || override.gamepadButton !== undefined)
    merged[key] = {
      ...defaultHotkey,
      ...(override && {
        accelerator: override.accelerator ?? defaultHotkey.accelerator,
        enabled: override.enabled ?? defaultHotkey.enabled,
        gamepadButtons: hasChord ? gamepadChord(override) : defaultHotkey.gamepadButtons
      })
    }
  }

  return merged
}
