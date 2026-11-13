import { memo, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isComposing, Kbd, Tooltip } from '@kit'
import { NotebookMatchChip } from './NotebookMatchChip'
import { NoteMarkdown } from './NoteMarkdown'
import { LineActionsMenu } from './LineActionsMenu'
import { getMatcher, matchLine, type Match } from '@texthooker/lib/nameMatch'
import { getNotebook } from '@texthooker/lib/notebook'
import { useNotebookCacheVersion } from '@texthooker/hooks/useNotebookCacheVersion'
import { getTranslateStatus, subscribeTranslateStatus } from '@texthooker/lib/translate'
import { NOTE_MAX_LENGTH, isNote, type Line } from '@texthooker/lib/types'
import { lineDate, lineTime } from '@texthooker/lib/logDays'
import { LineMedia } from './LineMedia'
import { endNote, keepNoteOpen, noteKeptOpen, stopEditing, useLineEditing } from '@texthooker/lib/lineEdit'
import { addNote, setLineText } from '@texthooker/lib/store'
import { ChevronDown, NotebookPen } from 'lucide-react'
import { useMentions } from '@texthooker/hooks/useMentions'

interface Props {
  line: Line
  translateEnabled: boolean
}

interface RenderPiece {
  kind: 'match' | 'plain'
  start: number
  end: number
  match?: Match
}

/** Walk the line and emit pieces: notebook matches, and the plain text between them. */
function buildRenderPieces(line: Line, matches: Match[]): RenderPiece[] {
  const pieces: RenderPiece[] = []
  const text = line.text
  let i = 0
  for (const match of matches) {
    // `start < i` is defensive: an overlapping match never re-renders text already emitted.
    if (match.end <= i) continue
    const start = Math.max(match.start, i)
    if (start > i) pieces.push({ kind: 'plain', start: i, end: start })
    pieces.push({ kind: 'match', start, end: match.end, match })
    i = match.end
  }
  if (i < text.length) pieces.push({ kind: 'plain', start: i, end: text.length })
  return pieces
}

/**
 * The row's gutter: its time, with the full date on hover, and the accent rail that slides in
 * while the row is hovered or its menu is open. CSS draws the time from `data-time`, so it is
 * never selected, copied or looked up with the line's text.
 */
export function LineGutter({ ts }: { ts: number }) {
  return (
    <>
      <span className="line-rail" aria-hidden />
      {ts ? (
        <Tooltip content={lineDate(ts)} delayDuration={300}>
          <time className="line-time" dateTime={new Date(ts).toISOString()} data-time={lineTime(ts)} />
        </Tooltip>
      ) : null}
    </>
  )
}

/**
 * A line's text in a box that grows with it, in the transcript's own type: editing a line or a
 * note (LineEditor), or writing a new note (AddNote). A line saves on Enter (Shift+Enter breaks
 * it); a note breaks its line on Enter and saves on ⌘+Enter, Ctrl+Enter or Shift+Enter. Never
 * while an input method is composing. Clicking away saves too; Escape keeps things as they were. Switching to another window leaves the box open. The row has no `data-yomitan-scan`, so
 * lookups leave the box alone.
 */
export function LineEditorBox({
  lineId,
  ts,
  initial,
  caret,
  minHeight,
  group,
  atEnd = false,
  note = false,
  label,
  hint,
  onFinish
}: {
  lineId?: Line['id']
  ts: number
  initial: string
  caret: number | null
  /** The row's height before it was edited, which it keeps at least. */
  minHeight?: number | null
  /** Its place in a scan's group of lines, which spaces the group from the lines above. */
  group?: Line['ocr']
  /** A new note at the Log's end: the Log stays scrolled to its very bottom while it's written. */
  atEnd?: boolean
  note?: boolean
  label: string
  hint?: (value: string) => string | null
  onFinish: (save: boolean, value: string) => void
}) {
  const [value, setValue] = useState(initial)
  const box = useRef<HTMLTextAreaElement>(null)
  const finished = useRef(false)
  // As tall as its lines, to the fraction of a pixel the row's text is (`scrollHeight` rounds, which
  // made the row grow by a hair on opening).
  const fit = () => {
    const el = box.current
    if (!el) return
    const style = getComputedStyle(el)
    const line = parseFloat(style.lineHeight)
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    el.style.height = 'auto'
    const lines = line > 0 ? Math.max(1, Math.round((el.scrollHeight - pad) / line)) : 0
    el.style.height = lines ? `${lines * line + pad}px` : `${el.scrollHeight}px`
    if (atEnd) toBottom(el)
    else reveal(el)
  }

  // Where the caret goes once a mention's text has rendered.
  const caretAfter = useRef<number | null>(null)
  // A note's @-mentions of the notebook's entries.
  const mentions = useMentions({
    box,
    value,
    apply: (text, at) => {
      caretAfter.current = at
      setValue(text)
    }
  })
  useLayoutEffect(() => {
    const el = box.current
    const at = caretAfter.current
    if (!el || at === null) return
    caretAfter.current = null
    el.setSelectionRange(at, at)
    fit()
    // Only when the text changes (a mention went in): `fit` is a fresh closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    fit()
    const at = caret ?? el.value.length
    el.focus({ preventScroll: true })
    el.setSelectionRange(at, at)
    if (atEnd) toBottom(el)
    else reveal(el)
    // Once as the box opens (and if the caret it starts at changes), not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caret])

  const finish = (save: boolean) => {
    if (finished.current) return
    finished.current = true
    onFinish(save, value)
  }

  const shown = hint?.(value)
  const textBox = (
    <textarea
      ref={box}
      className={note ? 'note-editor' : 'line-editor'}
      value={value}
      rows={1}
      spellCheck={false}
      aria-label={label}
      aria-description={
        note
          ? `Enter starts a new line, ${MAC ? 'Command' : 'Control'}+Enter or Shift+Enter saves, Escape cancels. Markdown supported; type @ to mention notebook entries.`
          : undefined
      }
      placeholder={note ? 'Write a note…' : undefined}
      maxLength={note ? NOTE_MAX_LENGTH : undefined}
      {...(note ? mentions.inputProps : {})}
      onChange={(e) => {
        setValue(e.target.value)
        fit()
        if (note) mentions.sync()
      }}
      onSelect={note ? mentions.sync : undefined}
      onKeyDown={(e) => {
        if (isComposing(e)) return
        if (note && mentions.onKeyDown(e)) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(false)
        } else if (
          e.key === 'Enter' &&
          // A note is written over several lines: Enter breaks the line, and Shift+Enter or
          // ⌘+Enter (Ctrl+Enter off the Mac) saves. A line is one line: Enter saves it.
          (note ? e.shiftKey || e.metaKey || e.ctrlKey : !e.shiftKey)
        ) {
          e.preventDefault()
          finish(true)
        }
      }}
      onBlur={() => {
        // The window lost focus (back to the game): keep editing.
        if (!document.hasFocus()) return
        finish(true)
      }}
      // The box's own menu (paste, undo) rather than the line's.
      onContextMenu={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
  return (
    <div
      className={`line line-editing${note ? ' line-editing-note' : ''}`}
      data-line-id={lineId}
      data-ocr-index={group?.groupIndex}
      data-ocr-count={group?.groupCount}
      style={minHeight && !note ? { minHeight } : undefined}
    >
      <LineGutter ts={ts} />
      {note ? (
        // A note is edited in its own card, opened out to its full length, with its keys on a
        // tab that slides out from under it.
        <div className="note-edit">
          <div className="note-card note-card-editing">
            <NoteIcon />
            <div className="note-main">{textBox}</div>
          </div>
          {mentions.menu}
          <NoteKeys length={value.length} />
        </div>
      ) : (
        textBox
      )}
      {shown ? (
        <span className="line-editor-hint" lang="en">
          {shown}
        </span>
      ) : null}
    </div>
  )
}

/** A note's mark, the Notebook's (NotebookNotes.tsx): the left column of its card. */
function NoteIcon() {
  return (
    <span className="note-icon" aria-hidden>
      <NotebookPen />
    </span>
  )
}

/**
 * The Log scrolled to its very end, past the box and the keys under it, clear of the activity
 * ticker (the Log keeps room for it there). Again once the keys' tab has slid out.
 */
function toBottom(el: HTMLElement) {
  const scroller = el.closest<HTMLElement>('.log-transcript')
  if (!scroller) return
  scroller.scrollTop = scroller.scrollHeight
  requestAnimationFrame(() => {
    scroller.scrollTop = scroller.scrollHeight
  })
}

/**
 * Scrolls the Log just enough that the row being edited (its box, and a note's keys under it) is
 * all in view, above the activity ticker where it floats; a row taller than the view keeps its top
 * in view. Once now and again on the next frame, as the box settles to its size.
 */
function reveal(el: HTMLElement) {
  const scroller = el.closest<HTMLElement>('.log-transcript')
  const row = el.closest<HTMLElement>('.line')
  if (!scroller || !row) return
  const step = () => {
    const view = scroller.getBoundingClientRect()
    const box = row.getBoundingClientRect()
    const margin = 8
    let bottom = view.bottom - margin
    const ticker = scroller.parentElement?.querySelector<HTMLElement>('.activity:not([data-hidden])')
    if (ticker) bottom = Math.min(bottom, ticker.getBoundingClientRect().top - margin)
    const top = view.top + margin
    if (box.top < top) {
      scroller.scrollTop -= top - box.top
    } else if (box.bottom > bottom) {
      // Down far enough to show its end, but never past its start.
      scroller.scrollTop += Math.min(box.bottom - bottom, box.top - top)
    }
  }
  step()
  requestAnimationFrame(step)
}

/** ⌘ on the Mac, Ctrl elsewhere: the key that saves a note with Enter. */
const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

/** The keys a note's editor takes, on the tab under it. */
function NoteKeys({ length }: { length: number }) {
  // Near the limit, how near: it counts once nine tenths of it are used.
  const near = length >= NOTE_MAX_LENGTH * 0.9
  return (
    <div className="note-keys" lang="en" aria-hidden>
      {near ? (
        <span className="note-keys-count k-num" data-full={length >= NOTE_MAX_LENGTH ? '' : undefined}>
          {length.toLocaleString()} / {NOTE_MAX_LENGTH.toLocaleString()}
        </span>
      ) : null}
      <span>
        <Kbd>↵</Kbd> New line
      </span>
      <span>
        <Kbd>{MAC ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd>↵</Kbd> Save
      </span>
      <span>
        <Kbd>Esc</Kbd> Cancel
      </span>
      <span className="note-keys-md">
        Markdown supported
        <span className="note-keys-dot">•</span>
        type <Kbd>@</Kbd> to mention notebook entries
      </span>
    </div>
  )
}

/** The line or note being edited in place. */
function LineEditor({ line, caret, height }: { line: Line; caret: number | null; height: number | null }) {
  const note = isNote(line)
  return (
    <LineEditorBox
      lineId={line.id}
      ts={line.ts}
      initial={line.text}
      caret={caret}
      minHeight={height}
      group={line.ocr}
      note={note}
      label={note ? 'Edit note' : 'Edit line'}
      hint={(value) =>
        !note && line.originalText !== undefined && line.originalText !== value
          ? `Recorded as: ${line.originalText}`
          : null
      }
      onFinish={(save, value) => {
        // A note opened out to be edited stays open.
        if (note) keepNoteOpen(line.id)
        stopEditing(line.id)
        if (save) void setLineText(line.id, value)
      }}
    />
  )
}

/** A new note at the end of the Log (`startNote`): saved as a line once it has any text. */
export function NoteDraft({ ts }: { ts: number }) {
  return (
    <LineEditorBox
      ts={ts}
      initial=""
      caret={null}
      note
      label="New note"
      atEnd
      onFinish={(save, value) => {
        endNote()
        if (save) void addNote(value)
      }}
    />
  )
}

/** A closed note's height, in its body's ems: `--note-cut` in log.css. */
const NOTE_CUT_EM = 9.5

/**
 * A note the person wrote: its Markdown rendered in a card that stands off the transcript. A long
 * one is cut short until opened (a click on it, or Show more), and closes again with Show less.
 * Links open in the browser, never in the Log.
 */
function NoteView({ line, translateEnabled }: Props) {
  const body = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(0)
  const [tall, setTall] = useState(false)
  const [open, setOpen] = useState(() => noteKeptOpen(line.id))

  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const measure = () => {
      setFull(el.scrollHeight)
      // Longer than a closed note shows (`--note-cut` in log.css, in the body's ems), open or not.
      const cut = parseFloat(getComputedStyle(el).fontSize) * NOTE_CUT_EM
      setTall(el.scrollHeight > cut + 2)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [line.text])

  const groupProps = { 'data-yomitan-scan': '' }
  return (
    <div className="line line-own-note" {...groupProps} data-line-id={line.id} data-line-text={line.text}>
      <LineGutter ts={line.ts} />
      <div className="note-card" data-tall={tall ? '' : undefined} data-open={open ? '' : undefined}>
        <NoteIcon />
        <div className="note-main">
          <NoteMarkdown
            ref={body}
            text={line.text}
            sentence={line.text}
            className="note-body explain-markdown"
            style={tall && open ? { maxHeight: full } : undefined}
            onClick={() => {
              // A click (not the end of a selection) on a cut-short note opens it.
              if (tall && !open && window.getSelection()?.isCollapsed) setOpen(true)
            }}
          />
          {tall ? (
            <button
              type="button"
              className="note-toggle"
              lang="en"
              aria-expanded={open}
              onClick={() => setOpen((was) => !was)}
            >
              <ChevronDown aria-hidden />
              {open ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </div>
      </div>
      <LineActionsMenu line={line} translateEnabled={translateEnabled} />
    </div>
  )
}

function LineRowInner({ line, translateEnabled }: Props) {
  const editing = useLineEditing(line.id)
  if (editing) return <LineEditor line={line} caret={editing.caret} height={editing.height} />
  if (isNote(line)) return <NoteView line={line} translateEnabled={translateEnabled} />
  return <LineView line={line} translateEnabled={translateEnabled} />
}

function LineView({ line, translateEnabled }: Props) {
  // Subscribe so this row re-renders when notebook content changes.
  const cacheVersion = useNotebookCacheVersion()
  // Transient translate status (loading / error) for this line.
  const translateStatus = useSyncExternalStore(subscribeTranslateStatus, () => getTranslateStatus(line.id))

  const matches: Match[] = useMemo(() => {
    const matcher = getMatcher(getNotebook())
    return matchLine(line, matcher)
    // Include cacheVersion so retroactive notebook edits invalidate this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.id, line.text, cacheVersion])

  // Every row form below spreads these. `data-yomitan-scan` is the only thing that lets the main
  // window's Yomitan scanner read text (ui/panel-yomitan.js): transcript lines are looked up, the
  // rest of the window (settings, sidebar, notebook) is not.
  const groupProps = {
    'data-yomitan-scan': '',
    ...(line.ocr
      ? {
          'data-ocr-scan': line.ocr.scanId,
          'data-ocr-index': line.ocr.groupIndex,
          'data-ocr-count': line.ocr.groupCount
        }
      : {})
  }

  // Interim state while DeepL is in flight: the row itself signals progress
  // (the menu closes immediately and the T hotkey has no other UI).
  if (translateStatus?.state === 'loading') {
    return (
      <div className="line" {...groupProps} data-line-id={line.id} data-line-text={line.text}>
        <LineGutter ts={line.ts} />
        <span className="line-pending">{line.text}</span>
        <span className="line-note line-pending" role="status">
          translating…
        </span>
        <LineMedia line={line} />
      </div>
    )
  }

  // Transient inline failure note (auto-clears after a few seconds).
  const translateNote =
    translateStatus?.state === 'error' ? (
      <span className="line-note line-note-danger" role="alert">
        translation failed: {translateStatus.message}
      </span>
    ) : null

  // Translated mode: plain selectable English at the inherited font size — no
  // notebook chips. The menu offers Copy (English) / Show original.
  if (line.showTranslation && line.translation) {
    return (
      <div
        className="line line-translated"
        lang="en"
        {...groupProps}
        data-line-id={line.id}
        data-line-text={line.translation}
      >
        <LineGutter ts={line.ts} />
        <span>{line.translation}</span>
        <LineMedia line={line} />
        <LineActionsMenu line={line} translateEnabled={translateEnabled} />
      </div>
    )
  }

  // Hot path: no notebook matches, so the line is its text.
  if (matches.length === 0) {
    return (
      <div
        className="line"
        {...groupProps}
        data-line-id={line.id}
        data-line-text={line.text}
        data-edited={line.originalText !== undefined ? '' : undefined}
      >
        <LineGutter ts={line.ts} />
        <span>{line.text}</span>
        <LineMedia line={line} />
        {translateNote}
        <LineActionsMenu line={line} translateEnabled={translateEnabled} />
      </div>
    )
  }

  const pieces = buildRenderPieces(line, matches)

  return (
    <div
      className="line"
      {...groupProps}
      data-line-id={line.id}
      data-line-text={line.text}
      data-edited={line.originalText !== undefined ? '' : undefined}
    >
      <LineGutter ts={line.ts} />
      {pieces.map((piece, i) => {
        if (piece.kind === 'match' && piece.match) {
          return (
            <NotebookMatchChip
              key={`m-${i}`}
              entryId={piece.match.entryId}
              text={line.text.slice(piece.start, piece.end)}
              sentence={line.text}
            />
          )
        }
        return <span key={`p-${i}`}>{line.text.slice(piece.start, piece.end)}</span>
      })}
      <LineMedia line={line} />
      {translateNote}
      <LineActionsMenu line={line} translateEnabled={translateEnabled} />
    </div>
  )
}

export const LineRow = memo(LineRowInner)
