/**
 * The reading history (src-tauri/src/reading_history.rs): every line read, with when, where from
 * and how it was captured, kept for stats and export apart from the Log. The Log's own transcript
 * is a view the person trims, clears and moves between sessions; the history only grows, except
 * when a line is deleted from the Log (a misreading, or a fragment a fuller reading replaced) or
 * corrected (Edit line).
 *
 * The store reports each change here (`historyAdd`, `historyEdit`, `historyDelete`); they are
 * sent to native in batches, a moment later or when the Log flushes. Sending never throws: the
 * history must never get in the way of reading.
 */
import { invoke } from '@tauri-apps/api/core'
import { isNote, type Line } from '../lib/types'
import { currentLanguage } from './language'

const DEBOUNCE_MS = 1000

/** Where the text came from, as the Log knows it when the line arrives. */
export interface HistorySource {
  /** The window's title (a game's or a video player's). */
  window?: string
  /** The application that owns the window. */
  app?: string
  /** The hooked game's executable (Text Hooker). */
  exe?: string
}

/** One change, as `reading_history_append` takes it (`reading_history::Event`). */
export interface HistoryEvent {
  op: 'add' | 'edit' | 'delete'
  uid: string
  /** When this change was made, epoch ms. */
  at: number
  /** When the line was read, epoch ms (absent for `delete`). */
  ts?: number
  text?: string
  /** The text as captured, when an edit corrected it. */
  originalText?: string
  /** How it was captured: `ocr`, `hook`, `clipboard`, `websocket`, `webhook`, `cli`. */
  via?: string
  /** The OCR engine, for `ocr`. */
  engine?: string
  session?: string
  sessionName?: string
  source?: HistorySource
  language?: string
  /** Minutes east of UTC where it was read, so days and hours are the reader's own. */
  tz?: number
}

let pending: HistoryEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let source: HistorySource | null = null
let sending: Promise<void> = Promise.resolve()

/** The source the next lines come from (the host follows the selected window and hooked game). */
export function setHistorySource(next: HistorySource | null): void {
  const clean: HistorySource = {}
  if (next?.window) clean.window = next.window
  if (next?.app) clean.app = next.app
  if (next?.exe) clean.exe = next.exe
  source = Object.keys(clean).length ? clean : null
}

function schedule(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flushHistory()
  }, DEBOUNCE_MS)
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
}

function push(event: HistoryEvent): void {
  pending.push(event)
  schedule()
}

function describe(op: 'add' | 'edit', line: Line, session: { id: string; name: string } | null): HistoryEvent {
  const event: HistoryEvent = {
    op,
    uid: line.uid!,
    at: Date.now(),
    ts: line.ts,
    text: line.text,
    via: line.source,
    language: currentLanguage(),
    tz: -new Date(line.ts).getTimezoneOffset()
  }
  if (line.originalText !== undefined) event.originalText = line.originalText
  if (line.ocr?.engine) event.engine = line.ocr.engine
  if (session) {
    event.session = session.id
    event.sessionName = session.name
  }
  if (source) event.source = { ...source }
  return event
}

/** A line was read and logged. Notes (the person's own writing) are not reading. */
export function historyAdd(line: Line, session: { id: string; name: string } | null): void {
  if (isNote(line) || !line.uid) return
  push(describe('add', line, session))
}

/** A logged line's text changed: a fuller reading of it, or the person corrected it. */
export function historyEdit(line: Line, session: { id: string; name: string } | null): void {
  if (isNote(line) || !line.uid) return
  push(describe('edit', line, session))
}

/** A line was deleted from the Log on purpose: it was not read after all. */
export function historyDelete(line: Line): void {
  if (isNote(line) || !line.uid) return
  push({ op: 'delete', uid: line.uid, at: Date.now() })
}

/** Send what is pending now. Never rejects; a batch native refused is dropped and logged. */
export function flushHistory(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!pending.length) return sending
  const events = pending
  pending = []
  sending = sending.then(() =>
    invoke('reading_history_append', { events }).then(
      () => undefined,
      (error) => console.warn('[history] could not record', events.length, 'lines:', error)
    )
  )
  return sending
}
