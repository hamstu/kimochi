/**
 * The main window's sidebar: where text comes from (Source, with its live preview and controls),
 * how OCR reads it (OCR model, for the OCR sources) and which session it goes into (Session), each
 * labelled, with Settings pinned to the bottom. The views (Log, Notebook) are tabs
 * across the top of the content. In the Settings view the same column lists the settings pages,
 * with a way back. Resizable from its right edge.
 */
import { useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import { ArrowLeft, ArrowUpRight, Settings } from 'lucide-react'
import { Row, Select } from '@kit'
import { getSettings, onSettingsChange } from '@texthooker/lib/settings'
import { OCR_MODES, type OcrMode } from '../bridge/settings'
import { useSetting } from '../bridge/useSetting'
import { SETTINGS_NAV } from '../panels/settings/settingsNav'
import type { SettingsTabName } from '../bridge/tauri'
import type { ControllerWiring } from '../panels/useController'
import { SourcePanel } from './SourcePanel'
import { SessionMenu } from './SessionMenu'

export type MainView = 'log' | 'notebook' | 'settings'

/** Narrowest and widest the sidebar can be dragged, in CSS pixels. */
const MIN_WIDTH = 160
const MAX_WIDTH = 360
export const DEFAULT_WIDTH = 216

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

const OCR_MODE_OPTIONS = (Object.keys(OCR_MODES) as OcrMode[]).map((value) => ({
  value,
  label: OCR_MODES[value].label
}))

/** The same engine choice as Settings → OCR, with a way there for the engine's own settings. */
function OcrModel({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const [ocrMode, setOcrMode] = useSetting<OcrMode>('ocrMode', 'cloud')
  return (
    <div className="sb-group">
      <div className="sb-label" id="sb-ocr-label">
        OCR model
      </div>
      <div className="sb-field">
        <Select
          aria-label="OCR model"
          className="sb-select"
          value={ocrMode}
          onValueChange={(value) => void setOcrMode(value)}
          options={OCR_MODE_OPTIONS}
        />
        <button type="button" className="sb-link" onClick={onOpenSettings}>
          OCR settings
          <ArrowUpRight />
        </button>
      </div>
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
  onBack
}: {
  width: number
  onResize: (width: number) => void
  view: MainView
  controller: ControllerWiring['props']
  onOpenSourceSettings: () => void
  settingsTab: SettingsTabName
  onSettingsTab: (tab: SettingsTabName) => void
  onBack: () => void
}): JSX.Element {
  // The width while a drag is in progress; the saved width otherwise.
  const [live, setLive] = useState<number | null>(null)
  const style = { width: live ?? width }
  const readsScreen = useReadsScreen()
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
          <SourcePanel controller={controller} onOpenSettings={onOpenSourceSettings} />
        </div>
        {readsScreen && <OcrModel onOpenSettings={() => onSettingsTab('ocr')} />}
        <div className="sb-group">
          <div className="sb-label" id="sb-session-label">
            Session
          </div>
          <div className="sb-field">
            <SessionMenu />
          </div>
        </div>
      </div>
      <div className="sb-footer">
        <Row icon={<Settings />} onClick={() => onSettingsTab(settingsTab)}>
          Settings
        </Row>
      </div>
      {handle}
    </aside>
  )
}
