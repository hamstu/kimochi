/**
 * The Log: Super Texthooker's transcript, and the host gate that starts its session owner. The
 * main window (`frontend/main/MainPanel.tsx`) composes these with its sidebar and the Notebook.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AArrowDown, AArrowUp, ChevronUp, ScrollText, X } from 'lucide-react'
import { Bar, BarSpacer, Button, Callout, EmptyState, IconButton, Spinner, StatusDot, Tooltip, type Tone } from '@kit'
import './log.css'
import { LineRow } from './components/LineRow'
import { dayLabel, dayStarts } from './lib/logDays'
import { ExplainModal } from './components/ExplainModal'
import { ScreenshotViewer } from './components/ScreenshotViewer'
import { AddToNotebookModal } from './components/AddToNotebookModal'
import { StatsFooter } from './components/StatsFooter'
import { LogMoreMenu } from './components/LogMoreMenu'
import { LineContextMenu } from './components/LineActionsMenu'
import { AddNote } from './components/AddNote'
import { useAddNoteHotkey } from './hooks/useAddNoteHotkey'
import { SessionMenu } from '../main/SessionMenu'
import { ActivityTicker } from './components/ActivityTicker'
import { useActivity } from '../bridge/activity'
import { useViewState } from '../bridge/state'
import { onEditModalRequest } from './lib/editModal'
import { getSettings, onSettingsChange, updateSettings } from './lib/settings'
import { getSnapshot, subscribe } from './bridge'
import { startHost } from './host'
import { bootMark } from '../entries/boot'
import { useClipboardPoll } from './hooks/useClipboardPoll'
import { useWebSocketInput } from './hooks/useWebSocketInput'
import { useTextHookInput } from './hooks/useTextHookInput'
import type { SocketStatus } from './websocket-input'
import { useScanMode } from './hooks/useScanMode'
import { useLineHotkeys } from './hooks/useLineHotkeys'
import { onLogDoubleClick, onLogMouseDown, stopEditing } from './lib/lineEdit'
import { onRevealRequest, pendingReveal, requestNotesFilter, takeReveal } from './lib/noteNav'
import { isNote } from './lib/types'
import { usePanelDictionary } from '../shell/panelDictionary'
import { openSettings } from '../bridge/tauri'
import { useAccount } from '../bridge/account'
import { translationAvailable } from '../../ui/account'
import { isEngineRejection } from '../../ui/engine-rejection.js'
import { useTextLang } from '../bridge/useTextLang'

/** Lines the Log shows at a time ("Show earlier lines" adds as many again). */
const PAGE_LINES = 100
/** Lines in the Log's first frame, before the rest of the page is laid out. */
const FIRST_FRAME_LINES = 30

/** Starts the session owner, then renders its children; shows progress or the failure meanwhile. */
export function ReaderHost({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const fail = (event: PromiseRejectionEvent) => {
      // The dictionary engine's own hiccups are logged by its host, not shown (engine-rejection.js).
      if (!isEngineRejection(event.reason)) setError(String(event.reason))
    }
    window.addEventListener('unhandledrejection', fail)
    return () => window.removeEventListener('unhandledrejection', fail)
  }, [])

  useEffect(() => {
    let active = true
    bootMark('log-start')
    void startHost()
      .then(() => {
        bootMark('log-loaded')
        if (active) setReady(true)
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
    return () => {
      active = false
    }
  }, [])
  if (!ready)
    return error ? (
      <div className="log-loading-error">
        <Callout tone="danger">{error}</Callout>
      </div>
    ) : (
      <div role="status" className="log-loading">
        <Spinner label="Loading" />
        Loading the log…
      </div>
    )
  return children
}

interface TranscriptProps {
  /** Shows the Notebook, with one entry open when an id is given. */
  onOpenNotebook: (entryId?: string) => void
  /** False while another view covers the Log; its intake and lookups keep running. */
  visible: boolean
}

export function Transcript({ onOpenNotebook, visible }: TranscriptProps) {
  const textLang = useTextLang()
  const [snap, setSnap] = useState(getSnapshot)
  const [settings, setSettings] = useState(getSettings)
  // Translate is offered when the chosen provider can be used: a DeepL key, or Kimochi Cloud.
  const { cloud } = useAccount()
  const translateEnabled = translationAvailable(settings.translationProvider, settings.deeplApiKey, cloud)
  const [error, setError] = useState('')
  useEffect(() => {
    const fail = (event: PromiseRejectionEvent) => {
      // The dictionary engine's own hiccups are logged by its host, not shown (engine-rejection.js).
      if (!isEngineRejection(event.reason)) setError(String(event.reason))
    }
    window.addEventListener('unhandledrejection', fail)
    return () => window.removeEventListener('unhandledrejection', fail)
  }, [])

  const [addText, setAddText] = useState<string | null>(null)
  const hasActivity = useActivity().length > 0
  // Auto OCR running: the ticker then just says so (and the Log keeps room for it).
  const autoOcr = Boolean(useViewState().state.autoOcrEnabled) && settings.inputSource === 'ocr'
  // The scan feed is OCR's (a hooked game's lines speak for themselves), and it can be turned off.
  const showTicker = settings.inputSource !== 'hook' && settings.showActivityTicker
  // The first frame lays out only the newest lines (laying out a full page of furigana held the
  // window's first frame back by ~130 ms); the rest follow right after it, below the fold.
  const [shown, setShown] = useState(FIRST_FRAME_LINES)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setTimeout(() => setShown((n) => Math.max(n, PAGE_LINES)), 0))
    return () => cancelAnimationFrame(frame)
  }, [])
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const apiMode = settings.dictionaryMode === 'custom-api'
  const lookup = usePanelDictionary(!apiMode)
  useEffect(() => subscribe(setSnap), [])
  useEffect(() => onSettingsChange(setSettings), [])
  const openNotebook = useRef(onOpenNotebook)
  useLayoutEffect(() => {
    openNotebook.current = onOpenNotebook
  })
  useEffect(() => onEditModalRequest((entryId) => openNotebook.current(entryId)), [])
  useEffect(() => {
    const listeners = [
      listen<{ message: string }>('reader:error', (e) => setError(e.payload.message)),
      listen<{ entryId: string }>('notebook:edit-request', (e) => {
        void invoke('hide_popover')
        openNotebook.current(e.payload.entryId)
      })
    ]
    return () => {
      for (const pending of listeners) void pending.then((stop) => stop())
    }
  }, [])
  const [inputStatus, setInputStatus] = useState<SocketStatus | null>(null)
  const [dismissedDictionaryWarning, dismissDictionaryWarning] = useState<string | null>(null)
  if (lookup.status === 'ready' && dismissedDictionaryWarning !== null) dismissDictionaryWarning(null)
  const socketStatus = useCallback((status: SocketStatus | null) => setInputStatus(status), [])
  useClipboardPoll()
  useWebSocketInput(socketStatus)
  useTextHookInput()
  useScanMode(apiMode)
  useLineHotkeys()
  useAddNoteHotkey(visible)
  // Another session opened (chosen here, or switched to for a browser tab's lines): start at
  // its newest line, wherever the last one was scrolled to.
  const shownSession = useRef(snap.sessions.activeId)
  useLayoutEffect(() => {
    if (shownSession.current !== snap.sessions.activeId) {
      shownSession.current = snap.sessions.activeId
      follow.current = true
      // Its lines are numbered afresh: an edit open in the last session is not one of them.
      stopEditing()
    }
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [snap.lines.length, snap.sessions.activeId, shown])
  const changeFont = (delta: number) =>
    void updateSettings({
      fontSizePx: Math.max(12, Math.min(48, settings.fontSizePx + delta))
    })
  const statusTone: Record<SocketStatus['state'], Tone> = {
    connected: 'ok',
    connecting: 'warn',
    retrying: 'warn',
    invalid: 'danger'
  }
  // Show in Log (a note in the Notebook): once the Log shows, lay out lines back to that one,
  // centre it and mark it for a moment. Following new lines stops, so it stays where it is.
  const [revealing, setRevealing] = useState(pendingReveal)
  useEffect(() => onRevealRequest(() => setRevealing(pendingReveal())), [])
  useLayoutEffect(() => {
    if (!revealing || !visible) return
    const index = snap.lines.findIndex((line) => line.uid === revealing)
    const done = () => {
      takeReveal()
      setRevealing(null)
    }
    if (index === -1) return done()
    follow.current = false
    const need = snap.lines.length - index
    if (shown < need) {
      // Lay out back to the line first; this effect scrolls to it on the next pass.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShown(need)
      return
    }
    done()
    const row = scroll.current?.querySelector<HTMLElement>(`.log-lines [data-line-id="${snap.lines[index].id}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    row.removeAttribute('data-flash')
    void row.offsetWidth
    row.setAttribute('data-flash', '')
    window.setTimeout(() => row.removeAttribute('data-flash'), 2000)
  }, [revealing, visible, shown, snap.lines])
  const noteCount = useMemo(() => snap.lines.filter(isNote).length, [snap.lines])

  const shownLines = snap.lines.slice(-shown)
  // A divider above each day's first line, once the session spans more than one day.
  const newDays = dayStarts(snap.lines, shownLines)

  return (
    <div className="texthooker app-root log-root" hidden={!visible}>
      {inputStatus && (
        <div role="status" className="log-status">
          <StatusDot tone={statusTone[inputStatus.state]} />
          <span>{inputStatus.message}</span>
        </div>
      )}
      {(error || (!apiMode && lookup.status === 'unavailable' && lookup.message !== dismissedDictionaryWarning)) && (
        <div className="log-callouts">
          {error && (
            <Callout tone="danger">
              <span className="log-callout-row">
                <span>{error}</span>
                <Button variant="ghost" size="sm" onClick={() => setError('')}>
                  Dismiss
                </Button>
              </span>
            </Callout>
          )}
          {!apiMode && lookup.status === 'unavailable' && lookup.message !== dismissedDictionaryWarning && (
            <Callout tone="warn">
              <span className="log-callout-row">
                <span>Dictionary: {lookup.message}</span>
                <IconButton
                  label="Dismiss dictionary warning"
                  size="sm"
                  onClick={() => dismissDictionaryWarning(lookup.message)}
                >
                  <X />
                </IconButton>
              </span>
            </Callout>
          )}
        </div>
      )}
      <div className="log-transcript-frame" data-activity={(showTicker && (hasActivity || autoOcr)) || undefined}>
        <main
          ref={scroll}
          onScroll={() => {
            const e = scroll.current
            if (e) follow.current = e.scrollHeight - e.scrollTop - e.clientHeight < 32
          }}
          className="log-transcript"
        >
          {!snap.lines.length && (
            <EmptyState
              className="log-empty"
              icon={<ScrollText />}
              title="No lines yet"
              actions={
                <Button size="sm" onClick={() => void openSettings('sources')}>
                  Source settings
                </Button>
              }
            >
              Choose a source in the sidebar.
            </EmptyState>
          )}
          {snap.lines.length > shown && (
            <div className="log-earlier">
              <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE_LINES)}>
                <ChevronUp />
                Show earlier lines
              </Button>
            </div>
          )}
          <LineContextMenu lines={snap.lines} translateEnabled={translateEnabled} onAddToNotebook={setAddText}>
            <div
              className="jp-text scan-region log-lines"
              onDoubleClick={(e) => onLogDoubleClick(e, snap.lines)}
              onMouseDown={onLogMouseDown}
              translate="no"
              lang={textLang}
              style={{ fontSize: settings.fontSizePx }}
            >
              {shownLines.map((line, i) => (
                <Fragment key={`${snap.sessions.activeId}:${line.id}`}>
                  {newDays.has(i) && (
                    <div className="log-day" role="separator" aria-label={dayLabel(line.ts)}>
                      <span>{dayLabel(line.ts)}</span>
                    </div>
                  )}
                  <LineRow line={line} translateEnabled={translateEnabled} />
                </Fragment>
              ))}
              <AddNote />
            </div>
          </LineContextMenu>
        </main>
        {showTicker && <ActivityTicker visible={visible} auto={autoOcr} />}
      </div>
      <Bar position="bottom">
        <StatsFooter
          lineCount={snap.lines.length - noteCount}
          noteCount={noteCount}
          onOpenNotes={() => {
            requestNotesFilter()
            onOpenNotebook()
          }}
        />
        <BarSpacer />
        <div className="log-bar-actions">
          <Tooltip content="Smaller text">
            <IconButton
              label="Smaller text"
              size="sm"
              disabled={settings.fontSizePx <= 12}
              onClick={() => changeFont(-1)}
            >
              <AArrowDown />
            </IconButton>
          </Tooltip>
          <Tooltip content="Larger text">
            <IconButton
              label="Larger text"
              size="sm"
              disabled={settings.fontSizePx >= 48}
              onClick={() => changeFont(1)}
            >
              <AArrowUp />
            </IconButton>
          </Tooltip>
          <span className="log-bar-divider" aria-hidden />
          <SessionMenu />
          <LogMoreMenu />
        </div>
      </Bar>
      <AddToNotebookModal text={addText} onClose={() => setAddText(null)} />
      <ExplainModal />
      <ScreenshotViewer />
    </div>
  )
}
