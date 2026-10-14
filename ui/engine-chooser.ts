/**
 * The engine choosers in Settings (OCR & Overlay → Engine, Dictionary → Engine), as pure
 * decisions. Both are a list beside a panel: the list only chooses what the panel shows (the
 * VIEWED engine); the panel's header is where an engine is made ACTIVE, with "Use <name>".
 */

/**
 * Where a key moves the highlight in an engine list of `count` items, from `index`; null for a
 * key the list leaves alone. Enter and Space are not here: on a row they only view it (it is
 * viewed already), and making an engine active is the panel's button.
 */
export function listKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(index + 1, count - 1)
    case 'ArrowUp':
      return Math.max(index - 1, 0)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** The label of the panel's button that makes the viewed engine active. */
export const activateLabel = (name: string): string => `Use ${name}`

/**
 * What the OCR panel's header offers for the engine it shows: "Active" when it is in use,
 * "Confirming…" while its model download is being asked about, else "Use <name>", disabled for
 * an engine this computer cannot run (the panel says why). A model that is not downloaded yet is
 * still "Use": choosing it asks to download first (`useEngineSelection`).
 */
export type OcrUseAction = 'active' | 'pending' | 'use' | 'unavailable'

export function ocrUseAction(state: { inUse: boolean; pending: boolean; selectable: boolean }): OcrUseAction {
  if (state.inUse) return 'active'
  if (state.pending) return 'pending'
  return state.selectable ? 'use' : 'unavailable'
}

/**
 * What the dictionary panel's header offers: "Active", "Switching when ready" while a switch
 * waits for its download, "Use <name>" when the engine's download is ready (or there is nothing
 * to download), and otherwise the download itself leads: "Download · 15 MB" for one never
 * downloaded, "Use when downloaded" for one under way, paused or failed. Either starts (or
 * resumes) the download and switches once it is ready.
 */
export type DictionaryUseAction = 'active' | 'pending' | 'use' | 'download' | 'resume'

export function dictionaryUseAction(state: {
  inUse: boolean
  pending: boolean
  /** The download's state, or null when there is none to report (nothing to download). */
  download: string | null
}): DictionaryUseAction {
  if (state.inUse) return 'active'
  if (state.pending) return 'pending'
  if (state.download === null || state.download === 'ready') return 'use'
  return state.download === 'absent' ? 'download' : 'resume'
}
