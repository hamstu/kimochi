/**
 * The Log's selection mode (Select, in a line's menu): several lines and notes picked at once, to
 * copy or delete together. While it is on, every row shows a checkbox, a click on a row toggles
 * it, Shift+click selects the rows from the last one clicked, and nothing in the Log is looked up
 * in the dictionary (App.tsx, `suppressPanelLookups`). The activity ticker's place holds its bar
 * (SelectionBar.tsx): the count, Copy text, Delete and Done.
 *
 * Rows are told apart by their `uid` (a line's `id` is numbered afresh when the Log is cleared,
 * so an id kept from before could name a new line). The model is plain functions over a state
 * value, with one shared store for the window and its rows.
 */
import { isNote, type Line } from './types'

export interface SelectionState {
  /** Selection mode is on. */
  readonly active: boolean
  /** The selected rows' keys (`lineKey`). */
  readonly selected: ReadonlySet<string>
  /** The row last clicked, where a Shift+click's range starts. */
  readonly anchor: string | null
}

export const IDLE: SelectionState = { active: false, selected: new Set(), anchor: null }

/** What a row is known by while selecting: its uid, which no other line in the Log shares. */
export const lineKey = (line: Pick<Line, 'id' | 'uid'>): string => line.uid ?? `#${line.id}`

/** Selection mode on, with `key`'s row selected (the row whose menu said Select). */
export const enter = (key: string): SelectionState => ({ active: true, selected: new Set([key]), anchor: key })

/** A click on a row: selected if it wasn't, and not if it was. It becomes the range's start. */
export function toggle(state: SelectionState, key: string): SelectionState {
  if (!state.active) return state
  const selected = new Set(state.selected)
  if (selected.has(key)) selected.delete(key)
  else selected.add(key)
  return { ...state, selected, anchor: key }
}

/**
 * A Shift+click on a row: every row from the last one clicked to this one is selected (as a
 * file list does), in the Log's order (`order`, its keys). With no row clicked yet, or the last
 * one gone, it is a plain click. The range's start stays where it was, so a second Shift+click
 * reaches out from the same row.
 */
export function selectRange(state: SelectionState, key: string, order: readonly string[]): SelectionState {
  if (!state.active) return state
  const to = order.indexOf(key)
  const from = state.anchor === null ? -1 : order.indexOf(state.anchor)
  if (to === -1 || from === -1) return toggle(state, key)
  const selected = new Set(state.selected)
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) selected.add(order[i])
  return { ...state, selected }
}

/**
 * The selection kept to the rows the Log still has (`present`, its keys): a row deleted or
 * replaced elsewhere (another window, Sync) drops out. The same state when nothing went.
 */
export function prune(state: SelectionState, present: ReadonlySet<string>): SelectionState {
  if (!state.active) return state
  let gone = false
  for (const key of state.selected) if (!present.has(key)) gone = true
  const anchorGone = state.anchor !== null && !present.has(state.anchor)
  if (!gone && !anchorGone) return state
  return {
    ...state,
    selected: gone ? new Set([...state.selected].filter((key) => present.has(key))) : state.selected,
    anchor: anchorGone ? null : state.anchor
  }
}

/** The selected lines and notes, in the Log's order. */
export const selectedLines = (lines: readonly Line[], selected: ReadonlySet<string>): Line[] =>
  lines.filter((line) => selected.has(lineKey(line)))

/**
 * Copy text: each selected row's text in the Log's order, one per line. A row copies what it
 * shows, as its own Copy does: the English of a translated line, a note's Markdown.
 */
export function selectionText(lines: readonly Line[], selected: ReadonlySet<string>): string {
  return selectedLines(lines, selected)
    .map((line) => (line.showTranslation && line.translation ? line.translation : line.text))
    .join('\n')
}

/** What is selected, in words: "3 lines", "1 note", "2 lines and 1 note", "Nothing". */
export function selectionLabel(lines: readonly Line[], selected: ReadonlySet<string>): string {
  const picked = selectedLines(lines, selected)
  const notes = picked.filter(isNote).length
  const read = picked.length - notes
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  if (read && notes) return `${count(read, 'line')} and ${count(notes, 'note')}`
  if (notes) return count(notes, 'note')
  if (read) return count(read, 'line')
  return 'Nothing'
}

// ------------------------------------------------------------------ the window's one selection

let current: SelectionState = IDLE
const subs = new Set<() => void>()

/** The selection now. */
export const currentSelection = (): SelectionState => current

/** True while selection mode is on: lookups and the line hotkeys stay off. */
export const selecting = (): boolean => current.active

export function setSelection(next: SelectionState): void {
  if (next === current) return
  current = next
  for (const fn of subs) fn()
}

export function subscribeSelection(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

/** Select (a line's menu): selection mode on, with that line selected. */
export const startSelecting = (line: Pick<Line, 'id' | 'uid'>): void => setSelection(enter(lineKey(line)))

/** Done, Escape, or nothing left to select: selection mode off, and nothing selected. */
export const stopSelecting = (): void => setSelection(IDLE)
