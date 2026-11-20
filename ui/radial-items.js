/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS shared by the overlay and Settings. */
/**
 * What the controller menu holds: which actions, in what order (`controllerMenuItems`, a list of
 * item ids clockwise from the top), and the shortcut each can have to run it without the menu.
 *
 * Shared by the overlay (ui/controller.js draws the menu from it) and Settings → Shortcuts &
 * Controls → Radial menu, which edits it. Nothing stored means the default menu, so a menu saved
 * before an action existed, or with ids since retired, still comes out usable, and never empty.
 *
 * Each item's shortcut is an ordinary hotkey (`hotkeys.<hotkey>`: keys and a controller chord),
 * registered natively like Scan's; native emits it as an action the overlay runs with
 * `controller.runItem`. Mirrored by `HOTKEY_ACTIONS` and `default_hotkeys` in Rust.
 */

/**
 * Every action the menu can hold, in the default order. `hotkey` is the action name native
 * dispatches for its shortcut; `when` says where the item applies: `ocr` only with an OCR source,
 * `hooker` only with the Text Hooker, otherwise always. `optional` items are not in the menu as it
 * ships: the reader adds them (Settings → Radial menu) or only uses their shortcut.
 *
 * @type {readonly {id: string, label: string, hotkey: string, description: string, when?: 'ocr'|'hooker', optional?: boolean}[]}
 */
export const RADIAL_ITEMS = [
  {
    id: 'scan',
    label: 'Scan',
    hotkey: 'menuScan',
    description: 'Scan the game, then read along with the new text.',
    when: 'ocr'
  },
  {
    id: 'dictionary',
    label: 'Read along',
    hotkey: 'menuReadAlong',
    description: 'Step through the text word by word with the dictionary.'
  },
  {
    id: 'auto',
    label: 'Auto OCR',
    hotkey: 'menuAutoOcr',
    description: 'Turn automatic scanning on or off.',
    when: 'ocr'
  },
  {
    id: 'card',
    label: 'Text Hooker',
    hotkey: 'menuTextHooker',
    description: "The hooked text and the card's settings.",
    when: 'hooker'
  },
  {
    id: 'history',
    label: 'Recent text',
    hotkey: 'menuRecentText',
    description: 'Lines read earlier, to read along with again.'
  },
  {
    id: 'controls',
    label: 'Kimochi',
    hotkey: 'menuKimochi',
    description: "Open Kimochi's window."
  },
  {
    id: 'ocr-settings',
    label: 'Settings',
    hotkey: 'menuSettings',
    description: "Open Kimochi's settings: OCR settings with an OCR source."
  },
  {
    id: 'pause',
    label: 'Pause game',
    hotkey: 'menuPause',
    description: 'Pause the game so a pop-up or tooltip stays up while you read it. Again, Escape or B to resume.',
    optional: true
  },
  {
    id: 'pause-scan',
    label: 'Pause & scan',
    hotkey: 'menuPauseScan',
    description: 'Pause the game, then scan it and read along with the new text.',
    when: 'ocr',
    optional: true
  },
  {
    id: 'pause-read-along',
    label: 'Pause & read along',
    hotkey: 'menuPauseReadAlong',
    description: 'Pause the game, then step through its text word by word with the dictionary.',
    when: 'ocr',
    optional: true
  }
]

/** The menu as it ships: every action that is not optional, in catalogue order. */
export const DEFAULT_RADIAL_MENU = RADIAL_ITEMS.filter((item) => !item.optional).map((item) => item.id)

/** An item's place in the catalogue: where an added item goes. */
const catalogueRank = (id) => RADIAL_ITEMS.findIndex((item) => item.id === id)

/** The setting holding the menu's item ids. */
export const RADIAL_MENU_SETTING = 'controllerMenuItems'

/** An item by id, or undefined. */
export function radialItem(id) {
  return RADIAL_ITEMS.find((item) => item.id === id)
}

/** The item a hotkey action runs, or undefined when `hotkey` is not an item's. */
export function radialItemForHotkey(hotkey) {
  return RADIAL_ITEMS.find((item) => item.hotkey === hotkey)
}

/**
 * The stored menu made usable: known ids only, each once, in the stored order. Nothing stored, or
 * nothing left once unknown ids are dropped, is the default menu: there is always an item.
 *
 * @param {unknown} stored
 * @returns {string[]}
 */
export function effectiveRadialMenu(stored) {
  if (!Array.isArray(stored)) return [...DEFAULT_RADIAL_MENU]
  const ids = []
  for (const id of stored) if (typeof id === 'string' && radialItem(id) && !ids.includes(id)) ids.push(id)
  return ids.length > 0 ? ids : [...DEFAULT_RADIAL_MENU]
}

/** Whether `menu` is the default one, so Reset has nothing to do. */
export function isDefaultRadialMenu(menu) {
  const ids = effectiveRadialMenu(menu)
  return ids.length === DEFAULT_RADIAL_MENU.length && ids.every((id, index) => id === DEFAULT_RADIAL_MENU[index])
}

/** The actions not in `menu`, in catalogue order: what can be added (optional ones included). */
export function missingRadialItems(menu) {
  const ids = effectiveRadialMenu(menu)
  return RADIAL_ITEMS.filter((item) => !ids.includes(item.id))
}

/**
 * `menu` with `id` added, at its catalogue place among what is there (so re-adding a removed item
 * puts it back where it was), unchanged if it is already in or unknown.
 */
export function addRadialItem(menu, id) {
  const ids = effectiveRadialMenu(menu)
  if (!radialItem(id) || ids.includes(id)) return ids
  const rank = catalogueRank(id)
  const at = ids.findIndex((other) => catalogueRank(other) > rank)
  return at < 0 ? [...ids, id] : [...ids.slice(0, at), id, ...ids.slice(at)]
}

/** Whether `id` can be removed: it is in the menu, and is not its last item. */
export function canRemoveRadialItem(menu, id) {
  const ids = effectiveRadialMenu(menu)
  return ids.length > 1 && ids.includes(id)
}

/** `menu` without `id`; the last item stays, as a menu with nothing in it could not be used. */
export function removeRadialItem(menu, id) {
  const ids = effectiveRadialMenu(menu)
  return canRemoveRadialItem(ids, id) ? ids.filter((other) => other !== id) : ids
}

/**
 * `menu` with the items `shown` (some of its ids, as a source shows them) put in that order, in
 * the places those items held: dragging round the ring with one kind of source never moves the
 * items that only the other kind shows.
 *
 * @param {unknown} menu
 * @param {string[]} shown
 */
export function reorderShownItems(menu, shown) {
  const ids = effectiveRadialMenu(menu)
  const moved = shown.filter((id) => ids.includes(id))
  if (moved.length !== new Set(moved).size) return ids
  let next = 0
  return ids.map((id) => (moved.includes(id) ? moved[next++] : id))
}

/**
 * The items the menu shows for a source: the configured ones that apply to it (`hooked`: the
 * Text Hooker is the source). When none do (a menu of only Scan, with the Text Hooker), all of
 * them, marked `inapplicable`, so the menu is never empty and says why nothing can be chosen.
 *
 * @param {unknown} stored
 * @param {boolean} hooked
 * @returns {{id: string, inapplicable: boolean}[]}
 */
export function radialItemsFor(stored, hooked) {
  const ids = effectiveRadialMenu(stored)
  const applies = (id) => {
    const when = radialItem(id)?.when
    return when === undefined || (when === 'hooker') === hooked
  }
  const shown = ids.filter(applies)
  if (shown.length > 0) return shown.map((id) => ({ id, inapplicable: false }))
  return ids.map((id) => ({ id, inapplicable: true }))
}

/** A hotkey's chord: `gamepadButtons`, or the legacy single `gamepadButton`; sorted, each once. */
function chordOf(binding) {
  const buttons = Array.isArray(binding?.gamepadButtons)
    ? binding.gamepadButtons
    : binding?.gamepadButtons === undefined && Number.isInteger(binding?.gamepadButton)
      ? [binding.gamepadButton]
      : []
  return [...new Set(buttons.filter(Number.isInteger))].sort((a, b) => a - b)
}

/**
 * The other enabled hotkeys that `name` collides with: the same keys, or the same controller
 * chord, so one press would run both (and natively only one of a chord pair fires). Names are
 * the hotkeys' display names. Accelerators compare case-insensitively.
 *
 * @param {Record<string, {name?: string, accelerator?: string, enabled?: boolean, gamepadButtons?: number[]|null, gamepadButton?: number}>} hotkeys
 * @param {string} name
 * @returns {{keys: string[], buttons: string[]}}
 */
export function hotkeyConflicts(hotkeys, name) {
  const own = hotkeys?.[name]
  const result = { keys: [], buttons: [] }
  if (!own || own.enabled === false) return result
  const keys = (own.accelerator ?? '').trim().toLowerCase()
  const chord = chordOf(own).join('+')
  for (const [other, binding] of Object.entries(hotkeys)) {
    if (other === name || !binding || binding.enabled === false) continue
    const label = binding.name ?? other
    if (keys && (binding.accelerator ?? '').trim().toLowerCase() === keys) result.keys.push(label)
    if (chord && chordOf(binding).join('+') === chord) result.buttons.push(label)
  }
  return result
}

export default {
  RADIAL_ITEMS,
  DEFAULT_RADIAL_MENU,
  RADIAL_MENU_SETTING,
  radialItem,
  radialItemForHotkey,
  effectiveRadialMenu,
  isDefaultRadialMenu,
  missingRadialItems,
  addRadialItem,
  canRemoveRadialItem,
  removeRadialItem,
  reorderShownItems,
  radialItemsFor,
  hotkeyConflicts
}
