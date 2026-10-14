/**
 * The main window's sidebar: where text comes from (Source, with its live preview and controls),
 * how OCR reads it (OCR model, for the OCR sources) and which session it goes into (Session), each
 * labelled, with Settings pinned to the bottom. OCR model and Session carry a "Manage" link on
 * their label row: to Settings → OCR & Overlay, and to the manage-sessions dialog. The views (Log, Notebook) are tabs
 * across the top of the content. In the Settings view the same column lists the settings pages,
 * with a way back. Resizable from its right edge.
 */
import { useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import { ArrowLeft, Settings } from 'lucide-react'
import { Row, SelectContent, SelectItem, SelectRoot, SelectTrigger, SelectValue } from '@kit'
import { getSettings, onSettingsChange } from '@texthooker/lib/settings'
import { engineListed } from '@ui/ocr-engines'
import { OCR_MODES, type OcrMode } from '../bridge/settings'
import { useEngineSelection } from '../bridge/useEngineSelection'
import { useCapabilities } from '../bridge/capabilities'
import { OcrEngineIcon, OcrRunsIcon } from '../components/EngineIcon'
import { SETTINGS_NAV } from '../panels/settings/settingsNav'
import { DownloadConfirmDialog } from '../panels/settings/DownloadConfirmDialog'
import type { SettingsTabName } from '../bridge/tauri'
import type { ControllerWiring } from '../panels/useController'
import { SourcePanel } from './SourcePanel'
import { SessionMenu } from './SessionMenu'
import { ModelStatusBadge } from './ModelStatusBadge'
import { UpdateNotice } from './UpdateNotice'
import { useLogActions } from './logActions'

export type MainView = 'log' | 'notebook' | 'settings'

/** Narrowest and widest the sidebar can be dragged, in CSS pixels. */
const MIN_WIDTH = 160
const MAX_WIDTH = 360
export const DEFAULT_WIDTH = 240

/** The sidebar's right edge: drag to resize, double-click to reset. */
function ResizeHandle({
  width,
  onLive,
  onCommit
}: {
  width: number
  onLive: (width: number | null) => void
  onCommit: (width: number) => void
}): JSX.Element {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null)
  const clamp = (value: number): number =>
    Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)))
  const end = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (!current) return
    drag.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    // Saved once, on release: a setting write per pointer move would flood every window.
    onCommit(current.last)
    onLive(null)
  }
  return (
    <div
      className="main-sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width, last: width }
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        current.last = clamp(current.width + event.clientX - current.x)
        onLive(current.last)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onCommit(DEFAULT_WIDTH)}
    />
  )
}

/** The quiet "Manage" link at the right of a group's label, on the label's baseline. */
function ManageLink({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="sb-manage" aria-label={label} onClick={onClick}>
      Manage
    </button>
  )
}

const OCR_MODE_LIST = Object.keys(OCR_MODES) as OcrMode[]

/** An engine as Settings lists it: its picture, its name and where it runs. Also the closed select. */
function OcrModeLabel({ mode }: { mode: OcrMode }): JSX.Element {
  return (
    <span className="sb-ocr-option">
      <OcrEngineIcon mode={mode} />
      <span className="sb-ocr-option-name">{OCR_MODES[mode].name}</span>
      <OcrRunsIcon mode={mode} />
    </span>
  )
}

/**
 * The same engine choice as Settings → OCR & Overlay (and the same download confirmation), with a way there
 * for the engine's own settings.
 */
function OcrModel({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const { ocrMode, shown, choose, confirmation } = useEngineSelection()
  const capabilities = useCapabilities()
  return (
    <div className="sb-group">
      <div className="sb-label sb-label-row">
        <span>
          <span id="sb-ocr-label">OCR model</span>
          <ModelStatusBadge engine={ocrMode} onOpenSettings={onOpenSettings} />
        </span>
        <ManageLink label="Manage OCR settings" onClick={onOpenSettings} />
      </div>
      <div className="sb-field">
        <SelectRoot value={shown} onValueChange={(value) => choose(value as OcrMode)}>
          <SelectTrigger aria-label="OCR model" className="sb-select sb-ocr-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="sb-ocr-menu">
            {OCR_MODE_LIST.filter((mode) => engineListed(mode, capabilities, ocrMode)).map((mode) => (
              <SelectItem
                key={mode}
                value={mode}
                description={
                  // Kimochi cloud without an access key is listed only while it is still selected.
                  mode === 'cloud' && !capabilities.cloudAccess ? 'Needs an access key' : OCR_MODES[mode].tagline
                }
              >
                <OcrModeLabel mode={mode} />
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
      </div>
      <DownloadConfirmDialog confirmation={confirmation} />
    </div>
  )
}

/** The OCR model only matters while the Log reads the screen. */
function useReadsScreen(): boolean {
  const [input, setInput] = useState(() => getSettings().inputSource)
  useEffect(() => onSettingsChange((next) => setInput(next.inputSource)), [])
  return input === 'ocr'
}

export function MainSidebar({
  width,
  onResize,
  view,
  controller,
  onOpenSourceSettings,
  settingsTab,
  onSettingsTab,
  onBack,
  chooseRequest
}: {
  width: number
  onResize: (width: number) => void
  view: MainView
  controller: ControllerWiring['props']
  onOpenSourceSettings: () => void
  settingsTab: SettingsTabName
  onSettingsTab: (tab: SettingsTabName) => void
  onBack: () => void
  /** Bumped to open the source menu on its window grid. */
  chooseRequest: number
}): JSX.Element {
  // The width while a drag is in progress; the saved width otherwise.
  const [live, setLive] = useState<number | null>(null)
  const style = { width: live ?? width }
  const readsScreen = useReadsScreen()
  const logActions = useLogActions()
  const handle = <ResizeHandle width={live ?? width} onLive={setLive} onCommit={onResize} />

  if (view === 'settings') {
    return (
      <aside className="main-sidebar" aria-label="Settings" style={style}>
        <div className="sb-scroll">
          <Row icon={<ArrowLeft />} className="sb-back" onClick={onBack}>
            Back
          </Row>
          <nav className="sb-nav" aria-label="Settings pages">
            {SETTINGS_NAV.map((item) => (
              <Row
                key={item.value}
                icon={item.icon}
                selected={item.value === settingsTab}
                onClick={() => onSettingsTab(item.value)}
              >
                {item.label}
              </Row>
            ))}
          </nav>
        </div>
        <UpdateNotice />
        {handle}
      </aside>
    )
  }

  return (
    <aside className="main-sidebar" aria-label="Sidebar" style={style}>
      <div className="sb-scroll">
        <div className="sb-group">
          <div className="sb-label" id="sb-source-label">
            Source
          </div>
          <SourcePanel
            controller={controller}
            onOpenSettings={onOpenSourceSettings}
            chooseRequest={chooseRequest}
          />
        </div>
        {readsScreen && <OcrModel onOpenSettings={() => onSettingsTab('ocr')} />}
        <div className="sb-group">
          <div className="sb-label sb-label-row">
            <span id="sb-session-label">Session</span>
            <ManageLink label="Manage sessions" onClick={logActions.manageSessions} />
          </div>
          <div className="sb-field">
            <SessionMenu />
          </div>
        </div>
      </div>
      <UpdateNotice />
      <div className="sb-footer">
        <Row icon={<Settings />} onClick={() => onSettingsTab(settingsTab)}>
          Settings
        </Row>
      </div>
      {handle}
    </aside>
  )
}
