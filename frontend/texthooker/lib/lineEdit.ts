import { useSyncExternalStore, type MouseEvent } from 'react'
import { isNote, type Line } from './types'

/**
 * Which Log line is being edited in place, if any, and where its caret starts. One at a time:
 * opening another saves nothing and closes the first (its own blur saves it first). Opened by a
 * double-click on the line, Edit line in its menu, or E over it (useLineHotkeys).
 */
interface Editing {
  id: Line['id']
  /** The caret's offset in the line's text; null puts it at the end. */
  caret: number | null
  /** The row's height as it showed: the editor keeps at least this, so nothing below moves (a
      row's voice and screenshot chips, not in the editor, can take a line of their own). */
  height: number | null
}

let editing: Editing | null = null
const subs = new Set<() => void>()

function set(next: Editing | null) {
  editing = next
  for (const fn of subs) fn()
}

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function editLine(id: Line['id'], caret: number | null = null): void {
  const row = document.querySelector<HTMLElement>(`.log-lines [data-line-id="${id}"]`)
  set({ id, caret, height: row ? row.getBoundingClientRect().height : null })
}

/** An edit chosen in a line's menu, opened once the menu has closed (`openEditAfterMenu`). */
let afterMenu: Line['id'] | null = null

/**
 * Edit line in the menu: the menu still holds focus and, closed from the keyboard, hands it back
 * to its trigger after fading out, which would end the edit at once. So the editor opens from the
 * menu's close-focus step, which it then skips; a fallback opens it should that step not come.
 */
export function editLineAfterMenu(id: Line['id']): void {
  afterMenu = id
  setTimeout(() => {
    if (afterMenu === id) openEditAfterMenu()
  }, 400)
}

/** For a line menu's `onCloseAutoFocus`: true when it opened a pending edit (focus stays put). */
export function openEditAfterMenu(event?: Event): boolean {
  if (afterMenu === null) return false
  event?.preventDefault()
  const id = afterMenu
  afterMenu = null
  editLine(id)
  return true
}

/** Ends editing `id`, or whatever line is being edited (another session was opened). */
export function stopEditing(id?: Line['id']): void {
  if (editing && (id === undefined || editing.id === id)) set(null)
  if (id === undefined) endNote()
}

/** How `id` is being edited (its caret and row height); undefined while it isn't. */
export function useLineEditing(id: Line['id']): Editing | undefined {
  return useSyncExternalStore(subscribe, () => (editing?.id === id ? editing : undefined))
}

/** Controls, chips and notes on a row keep their own double-click. */
const NOT_TEXT = "button, a, input, textarea, [role='button'], .line-actions, .line-media, .line-note, .note-toggle"

/**
 * The second press of a double-click on a line's text: the browser would start selecting the word
 * (and draw its selection across the row) before the editor opens. A double-click edits the line
 * instead, so that selection never starts.
 */
export function onLogMouseDown(event: MouseEvent): void {
  if (event.detail !== 2 || event.button !== 0) return
  const target = event.target as Element
  if (target.closest(NOT_TEXT) || !target.closest('[data-line-id]')) return
  event.preventDefault()
}

/**
 * A double-click on a line's text edits it, with the caret where it was clicked. Translated
 * rows edit their original text, so the caret goes to its end.
 */
export function onLogDoubleClick(event: MouseEvent, lines: readonly Line[]): void {
  const target = event.target as Element
  if (target.closest(NOT_TEXT)) return
  const row = target.closest<HTMLElement>('[data-line-id]')
  const line = row && lines.find((l) => String(l.id) === row.dataset.lineId)
  if (!row || !line) return
  event.preventDefault()
  // The double-click selected a word; the editor takes over from it.
  window.getSelection()?.removeAllRanges()
  // A note shows its Markdown rendered, so a point in it is no offset in its text.
  const atEnd = isNote(line) || Boolean(line.showTranslation && line.translation)
  editLine(line.id, atEnd ? null : caretAt(row, event.clientX, event.clientY, line.text.length))
}

/** A new note being written at the end of the Log (Add a note, or A): when it was begun. */
let draft: number | null = null
const draftSubs = new Set<() => void>()

function setDraft(next: number | null) {
  draft = next
  for (const fn of draftSubs) fn()
}

export function startNote(): void {
  if (draft === null) setDraft(Date.now())
}

export function endNote(): void {
  setDraft(null)
}

/** When the note being written was begun; null while none is. */
export function useNoteDraft(): number | null {
  return useSyncExternalStore(
    (fn) => {
      draftSubs.add(fn)
      return () => draftSubs.delete(fn)
    },
    () => draft
  )
}

/** The offset in `row`'s text of the point clicked, or null when it can't be told. */
function caretAt(row: HTMLElement, x: number, y: number, length: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null = null
  let offset = 0
  const position = doc.caretPositionFromPoint?.(x, y)
  if (position) {
    node = position.offsetNode
    offset = position.offset
  } else {
    const range = document.caretRangeFromPoint?.(x, y)
    if (range) {
      node = range.startContainer
      offset = range.startOffset
    }
  }
  if (!node || !row.contains(node)) return null
  // The row's text before the point: the time and rail draw none, so this counts the line's.
  const before = document.createRange()
  before.setStart(row, 0)
  before.setEnd(node, offset)
  return Math.min(before.toString().length, length)
}

/** Notes opened out in the Log: one that was edited stays open once saved. */
const openNotes = new Set<Line['id']>()

export function keepNoteOpen(id: Line['id']): void {
  openNotes.add(id)
}

export function noteKeptOpen(id: Line['id']): boolean {
  return openNotes.has(id)
}
