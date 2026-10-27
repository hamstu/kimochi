/**
 * The main window's sidebar: where text comes from (Source, with its live preview and controls),
 * how OCR reads it (OCR model, for the OCR sources) and which dictionary looks words up
 * (Dictionary), each labelled, with Settings pinned to the bottom under the update notice (while
 * an account is in use, the account switcher takes its place, with Settings in its menu; mini mode
 * keeps Settings). OCR model and Dictionary carry a
 * "Manage" link on their label row, to their Settings pages. The session picker is in the Log's
 * footer, beside its ⋯ menu. The views (Log, Notebook) are tabs
 * across the top of the content. In the Settings view the same column lists the settings pages,
 * with a way back. Resizable from its right edge.
 */
import { useEffect, useState, type JSX } from 'react'
import { ArrowLeft, Settings } from 'lucide-react'
import { ConfirmDialog, ResizeHandle, Row, SelectContent, SelectItem, SelectRoot, SelectTrigger, SelectValue } from '@kit'
import { getSettings, onSettingsChange } from '@texthooker/lib/settings'
import { engineListed } from '@ui/ocr-engines'
import { OCR_MODES, type OcrMode } from '../bridge/settings'
import { useEngineSelection } from '../bridge/useEngineSelection'
import { useCapabilities } from '../bridge/capabilities'
import { DictionaryEngineIcon, DictionaryRunsIcon, OcrEngineIcon, OcrRunsIcon } from '../components/EngineIcon'
import { DICTIONARY_ENGINES, type DictionaryEngine } from '../bridge/dictionaryEngine'
import { YomitanApiSetupDialog } from '../components/YomitanApiSetup'
import { useDictionarySwitch } from '../panels/settings/useDictionarySwitch'
import { DictionaryReadiness } from '../components/DictionaryReadiness'
import { SETTINGS_NAV } from '../panels/settings/settingsNav'
import { DownloadConfirmDialog } from '../panels/settings/DownloadConfirmDialog'
import { preloadSettingsPage } from '../panels/settings/settingsPages'
import type { SettingsTabName } from '../bridge/tauri'
import type { ControllerWiring } from '../panels/useController'
import { SourcePanel } from './SourcePanel'
import { ModelStatusBadge } from './ModelStatusBadge'
import { UpdateNotice } from './UpdateNotice'
import { activeAccount } from '@ui/account'
import { useAccount } from '../bridge/account'
import { AccountBar } from './AccountBar'

export type MainView = 'log' | 'notebook' | 'anki' | 'settings'

/** Narrowest and widest the sidebar can be dragged, in CSS pixels. */
const MIN_WIDTH = 200
const MAX_WIDTH = 360
export const DEFAULT_WIDTH = 272

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
    <span className="sb-engine-option">
      <OcrEngineIcon mode={mode} />
      <span className="sb-engine-option-name">{OCR_MODES[mode].name}</span>
      <OcrRunsIcon mode={mode} />
    </span>
  )
}

/**
 * The same engine choice as Settings → OCR & Overlay (and the same download confirmation), with a way there
 * for the engine's own settings.
 */
export function OcrModel({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
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
          <SelectTrigger aria-label="OCR model" className="sb-select sb-engine-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="sb-engine-menu">
            {OCR_MODE_LIST.filter((mode) => engineListed(mode, capabilities, ocrMode)).map((mode) => (
              <SelectItem
                key={mode}
                value={mode}
                description={
                  // Kimochi cloud without an account (or key) is listed only while it is still selected.
                  mode === 'cloud' && !capabilities.cloudAccess ? 'Sign in under Settings → Account' : OCR_MODES[mode].tagline
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

const DICTIONARY_LIST = Object.keys(DICTIONARY_ENGINES) as DictionaryEngine[]

/** A dictionary engine as Settings lists it: its picture, its name and where it runs. */
function DictionaryLabel({ engine }: { engine: DictionaryEngine }): JSX.Element {
  return (
    <span className="sb-engine-option">
      <DictionaryEngineIcon engine={engine} />
      <span className="sb-engine-option-name">{DICTIONARY_ENGINES[engine].name}</span>
      <DictionaryRunsIcon engine={engine} />
    </span>
  )
}

/**
 * A quick switch of dictionary engine, made exactly as Settings → Dictionary makes it (the same
 * download question, pending switch, reload and Yomitan API setup), with Manage for the rest.
 */
export function DictionaryPicker({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const dictionary = useDictionarySwitch('sidebar')
  const { active, pending, prompt, reloading, applyError } = dictionary
  const note = applyError
    ? applyError
    : reloading === 'self'
      ? `Switching to ${DICTIONARY_ENGINES[active].name}…`
      : pending
        ? `${DICTIONARY_ENGINES[pending].name} is used once it has downloaded.`
        : dictionary.verifyingApi
          ? 'Checking the Yomitan API…'
          : null
  return (
    <div className="sb-group">
      <div className="sb-label sb-label-row">
        <span id="sb-dictionary-label">Dictionary</span>
        <ManageLink label="Manage dictionary settings" onClick={onOpenSettings} />
      </div>
      <div className="sb-field">
        <SelectRoot value={active} onValueChange={(value) => void dictionary.choose(value as DictionaryEngine)}>
          <SelectTrigger aria-label="Dictionary" className="sb-select sb-engine-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="sb-engine-menu">
            {DICTIONARY_LIST.map((engine) => (
              <SelectItem key={engine} value={engine} description={DICTIONARY_ENGINES[engine].tagline}>
                <DictionaryLabel engine={engine} />
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        <DictionaryReadiness engine={active} />
        {note && (
          <span className="sb-note" data-tone={applyError ? 'danger' : undefined} role="status">
            {note}
          </span>
        )}
      </div>
      <ConfirmDialog
        open={dictionary.asking !== null}
        onOpenChange={(open) => {
          if (!open) dictionary.dismissAsking()
        }}
        title={prompt?.title ?? ''}
        description={prompt?.description}
        confirmLabel="Download"
        onConfirm={dictionary.confirmDownload}
        dismissOnOutsideClick
      />
      <YomitanApiSetupDialog
        open={dictionary.setupOpen}
        onOpenChange={dictionary.setSetupOpen}
        url={dictionary.apiUrl}
      />
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
  chooseRequest,
  mini = false,
  onChooseSource
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
  mini?: boolean
  onChooseSource?: () => void
}): JSX.Element {
  // The width while a drag is in progress; the saved width otherwise.
  const [live, setLive] = useState<number | null>(null)
  const style = mini ? undefined : { width: live ?? width }
  const readsScreen = useReadsScreen()
  // While an account is in use, its switcher takes Settings' place in the foot.
  const signedIn = activeAccount(useAccount()) !== null
  const handle = (
    <ResizeHandle
      width={live ?? width}
      min={MIN_WIDTH}
      max={MAX_WIDTH}
      reset={DEFAULT_WIDTH}
      label="Resize sidebar"
      onLive={setLive}
      onCommit={onResize}
    />
  )

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
                onPointerEnter={() => preloadSettingsPage(item.value)}
                onFocus={() => preloadSettingsPage(item.value)}
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
    <aside className="main-sidebar" aria-label="Sidebar" data-mini={mini || undefined} style={style}>
      <div className="sb-scroll">
        <div className="sb-group">
          <div className="sb-label" id="sb-source-label">
            Source
          </div>
          <SourcePanel
            controller={controller}
            onOpenSettings={onOpenSourceSettings}
            chooseRequest={chooseRequest}
            mini={mini}
            onChooseSource={onChooseSource}
          />
        </div>
        {readsScreen && <OcrModel onOpenSettings={() => onSettingsTab('ocr')} />}
        <DictionaryPicker onOpenSettings={() => onSettingsTab('dictionary')} />
      </div>
      <UpdateNotice />
      <div className="sb-footer">
        {!mini && signedIn ? (
          <AccountBar onOpen={() => onSettingsTab('account')} onSettings={() => onSettingsTab(settingsTab)} />
        ) : (
          <Row icon={<Settings />} onClick={() => onSettingsTab(settingsTab)}>
            Settings
          </Row>
        )}
      </div>
      {!mini && handle}
    </aside>
  )
}
