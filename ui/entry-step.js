/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * One controller press on the previous/next definition button (L1/R1 by default) moves the
 * Yomitan popup exactly one dictionary entry. Shared by the overlay's popup (ui/overlay.js) and
 * the desktop popup window on GNOME (ui/popup-host.js).
 *
 * The press is handed to Yomitan as its own `nextEntry` / `previousEntry` hotkey, so its current
 * entry, sticky header and smooth scroll stay its own. Yomitan's default profile binds each of those
 * actions twice: Alt+PageDown / Alt+PageUp with the argument "3", listed first, and Alt+↓ / Alt+↑
 * with "1". Only a hotkey that moves one entry is used (#257: the first one moved three, which with
 * many dictionaries is several screens). Without one, the popup is stepped here, by its `.entry`
 * elements, which are Yomitan's dictionary entries for terms and kanji alike.
 *
 * Pure, so it can be driven from a test (scripts/entry-step.test.mjs).
 */

/** How many entries a Yomitan entry hotkey moves, read as Yomitan's Display reads its argument. */
export function entryHotkeyCount(argument) {
  let count = typeof argument === 'number' ? argument : typeof argument === 'string' ? Number.parseInt(argument, 10) : 0
  if (!Number.isFinite(count)) count = 1
  return Math.max(0, Math.floor(count))
}

/**
 * The reader's enabled popup hotkey that moves one entry forwards (`step` > 0) or back, from a
 * Yomitan profile's `inputs.hotkeys`, as `{key, modifiers}`; null when there is none.
 */
export function singleEntryHotkey(hotkeys, step) {
  const action = step > 0 ? 'nextEntry' : 'previousEntry'
  const hotkey = (Array.isArray(hotkeys) ? hotkeys : []).find(
    (entry) =>
      entry?.action === action &&
      entry.enabled !== false &&
      typeof entry.key === 'string' &&
      entry.key !== '' &&
      (entry.scopes ?? []).includes('popup') &&
      entryHotkeyCount(entry.argument) === 1
  )
  return hotkey ? { key: hotkey.key, modifiers: hotkey.modifiers ?? [] } : null
}

/** The `KeyboardEvent` init that presses `hotkey` (a `code` such as `ArrowDown` or `KeyJ`). */
export function hotkeyKeydown(hotkey) {
  const modifiers = hotkey.modifiers ?? []
  return {
    key: hotkey.key.replace(/^Key/, '').toLowerCase(),
    code: hotkey.key,
    altKey: modifiers.includes('alt'),
    ctrlKey: modifiers.includes('ctrl'),
    shiftKey: modifiers.includes('shift'),
    metaKey: modifiers.includes('meta'),
    bubbles: true,
    cancelable: true
  }
}

/** How far above an entry's top the popup stops, so the entry's edge shows. */
export const ENTRY_MARGIN = 6
/** How far past an entry's top still counts as being on it. */
const ON_ENTRY = 8

/**
 * Where one step through the popup's entries lands, when Yomitan does not do it itself.
 *
 * `offsets` are the entries' tops in the scrolled content, in order; `from` is where the popup is
 * scrolled to (or is headed, mid-jump); `max` the furthest it scrolls. `last` is the previous step
 * (`{index, to}`): while the popup is still where it put it, that entry is the current one, since
 * near the bottom an entry cannot be brought to the top and its position no longer says which it
 * is. Returns `{index, to}`, the entry and the scroll position, or null when there is nowhere to go.
 *
 * Always exactly one entry: near the bottom, a step to an entry already in view leaves the scroll
 * where it is (`to` is `max`) and only changes which entry is current. The one exception is back
 * from partway down the first entry, which returns to its top.
 *
 * @param {{offsets: number[], from: number, max: number, step: number,
 *   last?: {index: number, to: number} | null}} position
 * @returns {{index: number, to: number} | null}
 */
export function entryStepTarget({ offsets, from, max, step, last = null }) {
  if (!offsets?.length || !step) return null
  let current = 0
  if (last && Number.isInteger(last.index) && last.index < offsets.length && Math.abs(from - last.to) <= 2) {
    current = last.index
  } else {
    offsets.forEach((offset, index) => {
      if (offset <= from + ON_ENTRY) current = index
    })
  }
  const index = Math.max(0, Math.min(offsets.length - 1, current + Math.sign(step)))
  if (index === current) {
    // Back from partway down the first entry: to the top, where its headword is.
    return step < 0 && index === 0 && from > 0 ? { index: 0, to: 0 } : null
  }
  const to = index === 0 ? 0 : Math.min(Math.max(0, max), Math.max(0, offsets[index] - ENTRY_MARGIN))
  return { index, to }
}
