import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Copy, MoreHorizontal, NotebookPen, ScrollText, Trash2, X } from 'lucide-react'
import {
  Bar,
  BarSpacer,
  Button,
  ContextMenu,
  ContextMenuTrigger,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Kbd,
  Row,
  Segmented,
  Textarea,
  isComposing
} from '@kit'
import { writeTextSelf } from '@texthooker/lib/clipboardWrite'
import { lineDate } from '@texthooker/lib/logDays'
import { noteItemId, noteRest, noteTitle } from '@texthooker/lib/noteNav'
import { deleteLine, setLineText } from '@texthooker/lib/store'
import { NOTE_MAX_LENGTH, type Line } from '@texthooker/lib/types'
import { useMentions } from '@texthooker/hooks/useMentions'
import { NoteMarkdown } from './NoteMarkdown'

/**
 * The person's notes in the Notebook (written in the Log with Add a note): a group in the list,
 * each note's menu, and the pane that edits one. A note is a line of the Log, so editing it here
 * changes it there, and Show in Log goes to it.
 */

export interface NoteActions {
  onEdit: (note: Line) => void
  onShowInLog: (note: Line) => void
}

/** What can be done with a note: the ⋯ menu and a right-click list the same (and their letters). */
function NoteMenuItems({ note, onEdit, onShowInLog }: NoteActions & { note: Line }) {
  return (
    <>
      <MenuItem icon={<NotebookPen />} shortcut="e" onSelect={() => onEdit(note)}>
        Edit
      </MenuItem>
      <MenuItem icon={<ScrollText />} shortcut="l" onSelect={() => onShowInLog(note)}>
        Show in Log
      </MenuItem>
      <MenuItem icon={<Copy />} shortcut="c" onSelect={() => void writeTextSelf(note.text).catch(() => {})}>
        Copy text
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Trash2 />} tone="danger" shortcut="d" onSelect={() => void deleteLine(note.id)}>
        Delete note
      </MenuItem>
    </>
  )
}

/** A right-click on a note row opens its menu; the entries' own menu never sees it. */
export function NoteContextMenu({
  notes,
  children,
  ...actions
}: NoteActions & { notes: readonly Line[]; children: ReactNode }) {
  const [target, setTarget] = useState<string | null>(null)
  const row = useRef<HTMLElement | null>(null)
  const note = notes.find((n) => noteItemId(n) === target)
  const onContextMenu = (event: MouseEvent) => {
    // The list's entry menu wraps this one: it must not also open.
    event.stopPropagation()
    const rowElement = (event.target as Element).closest<HTMLElement>('[data-note-item]')
    const id = rowElement?.dataset.noteItem
    if (!id || !notes.some((n) => noteItemId(n) === id)) {
      event.preventDefault()
      return
    }
    row.current?.removeAttribute('data-menu-open')
    row.current = rowElement
    rowElement?.setAttribute('data-menu-open', '')
    setTarget(id)
  }
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) return
        row.current?.removeAttribute('data-menu-open')
        row.current = null
        setTarget(null)
      }}
    >
      <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
        {children}
      </ContextMenuTrigger>
      <MenuContent>{note ? <NoteMenuItems note={note} {...actions} /> : null}</MenuContent>
    </ContextMenu>
  )
}

/** The notes in the list: under a "Notes" label when other kinds show too. */
export function NoteRows({
  notes,
  showLabel,
  current,
  highlight,
  editingId,
  ...actions
}: NoteActions & {
  notes: readonly Line[]
  showLabel: boolean
  current: string | null
  highlight: boolean
  editingId: string | null
}) {
  return (
    <NoteContextMenu notes={notes} {...actions}>
      <div role="presentation" className="nb-note-group">
        {showLabel ? (
          <div className="nb-group" role="presentation">
            Notes
            <span className="k-num">{notes.length}</span>
          </div>
        ) : null}
        {notes.map((note) => {
          const id = noteItemId(note)
          return (
            <NoteRow
              key={id}
              note={note}
              current={id === current}
              selected={highlight && id === current}
              editing={id === editingId}
              {...actions}
            />
          )
        })}
      </div>
    </NoteContextMenu>
  )
}

function NoteRow({
  note,
  current,
  selected,
  editing,
  ...actions
}: NoteActions & { note: Line; current: boolean; selected: boolean; editing: boolean }) {
  const id = noteItemId(note)
  const title = noteTitle(note.text)
  const rest = noteRest(note.text)
  return (
    <div className="nb-row-wrap" data-note-item={id}>
      <Row
        role="option"
        aria-selected={selected}
        tabIndex={current ? 0 : -1}
        data-entry-id={id}
        data-editing={editing ? '' : undefined}
        className="nb-row"
        icon={
          <span className="nb-note-avatar" aria-hidden>
            <NotebookPen />
          </span>
        }
        onClick={() => actions.onEdit(note)}
        trailing={<span className="nb-meta nb-note-when k-num">{lineDate(note.ts)}</span>}
      >
        <span className="nb-row-title">
          <span className="nb-name nb-note-name">{title || 'Note'}</span>
        </span>
        <span className={rest ? 'nb-sub' : 'nb-sub nb-sub-empty'}>{rest || 'No more text'}</span>
      </Row>
      <Menu>
        <MenuTrigger asChild>
          <IconButton
            label={`Actions for ${title || 'note'}`}
            size="sm"
            className="nb-row-actions"
            // The list moves between rows with the arrow keys; this button is reached by pointer.
            tabIndex={-1}
          >
            <MoreHorizontal />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <NoteMenuItems note={note} {...actions} />
        </MenuContent>
      </Menu>
    </div>
  )
}

/**
 * The note in the Notebook's side pane: its Markdown to edit, saved as it's typed (to the Log
 * too), and how it reads below. Show in Log goes to it in the Log; Escape closes the pane.
 */
type NoteMode = 'edit' | 'preview'
const NOTE_MODES = [
  { value: 'edit' as const, label: 'Edit' },
  { value: 'preview' as const, label: 'Preview' }
]
/** The view the pane last showed a note in: it opens the next one the same way. */
let lastMode: NoteMode = 'preview'

export function NotePane({
  note,
  width,
  resizeHandle,
  onClose,
  onShowInLog
}: {
  note: Line
  width: number
  resizeHandle: ReactNode
  onClose: () => void
  onShowInLog: (note: Line) => void
}) {
  // Preview to read a note, Edit to change it; the last one chosen holds for the next note.
  const [mode, setModeState] = useState<NoteMode>(() => (note.text.trim() ? lastMode : 'edit'))
  const setMode = (next: NoteMode) => {
    lastMode = next
    setModeState(next)
    // Straight into the text, at its end.
    if (next === 'edit')
      requestAnimationFrame(() => {
        const el = box.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      })
  }
  const box = useRef<HTMLTextAreaElement>(null)
  // Where the caret goes once a mention, saved to the Log, comes back as the note's text.
  const caretAfter = useRef<number | null>(null)
  const mentions = useMentions({
    box,
    value: note.text,
    apply: (text, at) => {
      caretAfter.current = at
      void setLineText(note.id, text)
    }
  })
  useLayoutEffect(() => {
    const el = box.current
    const at = caretAfter.current
    if (!el || at === null || el.value.length < at) return
    caretAfter.current = null
    el.setSelectionRange(at, at)
  }, [note.text])
  return (
    <aside
      className="nb-editor nb-note-editor"
      aria-label="Edit note"
      style={{ width }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !isComposing(event) && !event.defaultPrevented) {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <header className="nb-note-head">
        <span className="nb-note-avatar" aria-hidden>
          <NotebookPen />
        </span>
        <span className="nb-note-head-text">
          <span className="nb-note-head-title">Note</span>
          <span className="nb-note-head-when k-num">Written in the Log · {lineDate(note.ts)}</span>
        </span>
        <IconButton label="Close editor" size="sm" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div className="nb-editor-body">
        <div className="nb-lognote">
          <div className="nb-lognote-bar">
            <Segmented aria-label="Note view" value={mode} onValueChange={setMode} options={NOTE_MODES} />
            {mode === 'edit' ? (
              <span className="nb-lognote-hint">
                {note.text.length >= NOTE_MAX_LENGTH * 0.9 ? (
                  <span className="nb-lognote-count k-num">
                    {note.text.length.toLocaleString()} / {NOTE_MAX_LENGTH.toLocaleString()} ·
                  </span>
                ) : null}
                Markdown · <Kbd>@</Kbd> to mention
              </span>
            ) : null}
          </div>
          {mode === 'edit' ? (
            <>
              <Textarea
                ref={box}
                key={note.id}
                className="nb-lognote-text"
                aria-label="Note"
                rows={10}
                value={note.text}
                placeholder="Write a note…"
                maxLength={NOTE_MAX_LENGTH}
                {...mentions.inputProps}
                onChange={(e) => {
                  void setLineText(note.id, e.target.value)
                  mentions.sync()
                }}
                onSelect={mentions.sync}
                onKeyDown={(e) => {
                  if (mentions.onKeyDown(e)) return
                }}
              />
              {mentions.menu}
            </>
          ) : (
            <NoteMarkdown
              key={note.id}
              text={note.text}
              sentence={note.text}
              className="nb-lognote-preview explain-markdown"
              lang="ja"
              onDoubleClick={() => setMode('edit')}
            />
          )}
        </div>
      </div>
      <Bar position="bottom" className="nb-editor-foot">
        <Button variant="ghost" size="sm" onClick={() => onShowInLog(note)}>
          <ScrollText />
          Show in Log
        </Button>
        <BarSpacer />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onClose()
            void deleteLine(note.id)
          }}
        >
          <Trash2 />
          Delete
        </Button>
      </Bar>
      {resizeHandle}
    </aside>
  )
}
