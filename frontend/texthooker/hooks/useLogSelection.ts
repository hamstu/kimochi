import { useSyncExternalStore } from 'react'
import { currentSelection, subscribeSelection, type SelectionState } from '@texthooker/lib/logSelection'

/** The Log's selection (lib/logSelection.ts), re-rendering as it changes. */
export const useLogSelection = (): SelectionState => useSyncExternalStore(subscribeSelection, currentSelection)

/** True while selection mode is on. */
export const useSelecting = (): boolean => useSyncExternalStore(subscribeSelection, () => currentSelection().active)

/**
 * Whether the row known by `key` shows a checkbox, and whether it is ticked: `null` outside
 * selection mode. Only rows whose answer changes re-render.
 */
export function useRowSelection(key: string): boolean | null {
  return useSyncExternalStore(subscribeSelection, () => {
    const state = currentSelection()
    return state.active ? state.selected.has(key) : null
  })
}
