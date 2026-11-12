/**
 * The main window's sidebar: where text comes from (Source, with its live preview and controls),
 * how OCR reads it (OCR model, for the OCR sources) and which dictionary looks words up
 * (Dictionary), each labelled, with Settings pinned to the bottom under the update notice (while
 * an account is in use, the account switcher takes its place, with Settings in its menu; mini mode
 * keeps Settings). OCR model and Dictionary carry a
 * "Settings" link on their label row, to their Settings pages. The session picker is in the Log's
 * footer, beside its ⋯ menu. The views (Log, Notebook) are tabs
 * across the top of the content. In the Settings view the same column lists the settings pages,
 * with a way back. Resizable from its right edge.
 */
import { useEffect, useState, type JSX } from 'react'
import { ArrowLeft, Settings } from 'lucide-react'
import { ConfirmDialog, ResizeHandle, Row, SelectContent, SelectItem, SelectRoot, SelectTrigger, SelectValue } from '@kit'
import { getSettings, onSettingsChange } from '@texthooker/lib/settings'
import { engineListed } from '@ui/ocr-engines'
import { useLanguage } from '../bridge/useLanguage'
import { OCR_MODES, ocrModeInfo, type OcrMode } from '../bridge/settings'
import { useHookStatus } from '../bridge/textHook'
import { useHookPlacement } from './hookPlacement'
import { useEngineSelection } from '../bridge/useEngineSelection'
import { useCapabilities } from '../bridge/capabilities'
import { DictionaryEngineIcon, DictionaryRunsIcon, OcrEngineIcon, OcrRunsIcon } from '../components/EngineIcon'
import { DICTIONARY_ENGINES, dictionaryEngineLanguageReason, type DictionaryEngine } from '../bridge/dictionaryEngine'
import { YomitanApiSetupDialog } from '../components/YomitanApiSetup'
import { useDictionarySwitch } from '../panels/settings/useDictionarySwitch'
import { useDictionaryReadiness } from '../bridge/dictionaryReadiness'
import { useExtensionStatus } from '../bridge/extensions'
import { downloadEngineFor } from '@ui/extension-download'
import { percent } from '@ui/model-download'
import { settingsNavFor } from '../panels/settings/settingsNav'
import { DownloadConfirmDialog } from '../panels/settings/DownloadConfirmDialog'
import { preloadSettingsPage } from '../panels/settings/settingsPages'
import type { SettingsTabName } from '../bridge/tauri'
import type { ControllerWiring } from '../panels/useController'
import { SourcePanel } from './SourcePanel'
import { BrowserEngines } from './BrowserEngines'
import { SettingsLink } from './SettingsLink'
import { useOcrModelState } from './modelState'
import { EngineValue } from './EngineValue'
import { progressProps, useSteadyProgress, type FieldProgress } from './fieldProgress'
import { SidebarNotice } from './SidebarNotice'
import { UpdateNotice } from './UpdateNotice'
import { activeAccount } from '@ui/account'
import { useAccount } from '../bridge/account'
import { AccountBar } from './AccountBar'

export type MainView = 'source' | 'log' | 'notebook' | 'anki' | 'settings'

/** Narrowest and widest the sidebar can be dragged, in CSS pixels. */
const MIN_WIDTH = 200
const MAX_WIDTH = 360
export const DEFAULT_WIDTH = 272

const OCR_MODE_LIST = Object.keys(OCR_MODES) as OcrMode[]

/** An engine as Settings lists it: its picture, its name and where it runs. Also the closed select. */
function OcrModeLabel({ mode, busy = null }: { mode: OcrMode; busy?: FieldProgress | null }): JSX.Element {
  return (
    <EngineValue picture={<OcrEngineIcon mode={mode} />} name={ocrModeInfo(mode).name} runs={<OcrRunsIcon mode={mode} />} busy={busy} />
  )
}

/**
 * The same engine choice as Settings → OCR & Overlay (and the same download confirmation), with a way there
 * for the engine's own settings.
 */
export function OcrModel({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const { ocrMode, shown, choose, confirmation } = useEngineSelection()
  const capabilities = useCapabilities()
  const [language] = useLanguage()
  const model = useOcrModelState(ocrMode)
  // Only the selected engine's model is followed; a pick still being confirmed shows plainly.
  const busy = useSteadyProgress(shown === ocrMode ? model.busy : null, ocrMode)
  return (
    <div className="sb-group">
      <div className="sb-label sb-label-row">
        <span id="sb-ocr-label">OCR model</span>
        <SettingsLink label="OCR settings" onClick={onOpenSettings} />
      </div>
      <div className="sb-field">
        <SelectRoot value={shown} onValueChange={(value) => choose(value as OcrMode)}>
          <SelectTrigger aria-label="OCR model" className="sb-select sb-engine-select" {...progressProps(busy)}>
            <SelectValue>
              <OcrModeLabel mode={shown} busy={busy} />
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="sb-engine-menu">
            {OCR_MODE_LIST.filter((mode) => engineListed(mode, capabilities, ocrMode, language.code)).map((mode) => (
              <SelectItem
                key={mode}
                value={mode}
                description={
                  // Kimochi cloud without an account (or key) is listed only while it is still selected.
                  mode === 'cloud' && !capabilities.cloudAccess ? 'Sign in under Settings → Account' : ocrModeInfo(mode).tagline
                }
              >
                <OcrModeLabel mode={mode} />
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        {model.notice && shown === ocrMode && (
          <SidebarNotice action="Open OCR settings" onAction={onOpenSettings} title={model.notice.title}>
            {model.notice.text}
          </SidebarNotice>
        )}
      </div>
      <DownloadConfirmDialog confirmation={confirmation} />
    </div>
  )
}

const DICTIONARY_LIST = Object.keys(DICTIONARY_ENGINES) as DictionaryEngine[]

/** A dictionary engine as Settings lists it: its picture, its name and where it runs. */
function DictionaryLabel({ engine, busy = null }: { engine: DictionaryEngine; busy?: FieldProgress | null }): JSX.Element {
  return (
    <EngineValue
      picture={<DictionaryEngineIcon engine={engine} />}
      name={DICTIONARY_ENGINES[engine].name}
      runs={<DictionaryRunsIcon engine={engine} />}
      busy={busy}
    />
  )
}

/**
 * A quick switch of dictionary engine, made exactly as Settings → Dictionary makes it (the same
 * download question, pending switch, reload and Yomitan API setup), with Settings for the rest.
 */
export function DictionaryPicker({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const dictionary = useDictionarySwitch('sidebar')
  const { active, pending, prompt, reloading, applyError } = dictionary
  const readiness = useDictionaryReadiness(active)
  // A switch waiting for its engine's download: that download is the first step of the new
  // engine's setup, and the select shows the engine it is for.
  const pendingDownload = useExtensionStatus(pending ? downloadEngineFor(pending) : null)
  const shownEngine = pending ?? active
  const raw: FieldProgress | null = pending
    ? pendingDownload?.state === 'downloading'
      ? (() => {
          const value = percent(pendingDownload.overallReceived, pendingDownload.overallTotal) / 2
          return { value, exact: true, short: `${Math.floor(value)}%`, title: `Downloading ${DICTIONARY_ENGINES[pending].name}` }
        })()
      : {
          value: 50,
          exact: false,
          short: pendingDownload?.state === 'verifying' ? 'Verifying…' : pendingDownload?.state === 'ready' ? 'Switching…' : 'Waiting…',
          title: `${DICTIONARY_ENGINES[pending].name} is used once it has downloaded`
        }
    : reloading === 'self'
      ? { value: readiness.setup?.value ?? 0, exact: false, short: 'Switching…', title: `Switching to ${DICTIONARY_ENGINES[active].name}` }
      : dictionary.verifyingApi
        ? { value: 0, exact: false, short: 'Checking…', title: 'Checking the Yomitan API' }
        : readiness.setup
          ? {
              ...readiness.setup,
              short: readiness.setup.exact ? `${Math.floor(readiness.setup.value)}%` : readiness.view.short,
              title: readiness.view.text
            }
          : null
  const busy = useSteadyProgress(raw, shownEngine)
  const notice = applyError
    ? { tone: 'danger' as const, text: 'Couldn’t switch dictionary.', title: applyError }
    : !busy && readiness.view.show && readiness.view.notice
      ? { tone: 'warn' as const, text: readiness.view.notice, title: readiness.view.text }
      : null
  return (
    <div className="sb-group">
      <div className="sb-label sb-label-row">
        <span id="sb-dictionary-label">Dictionary</span>
        <SettingsLink label="Dictionary settings" onClick={onOpenSettings} />
      </div>
      <div className="sb-field">
        <SelectRoot value={active} onValueChange={(value) => void dictionary.choose(value as DictionaryEngine)}>
          <SelectTrigger aria-label="Dictionary" className="sb-select sb-engine-select" {...progressProps(busy)}>
            <SelectValue>
              <DictionaryLabel engine={shownEngine} busy={busy} />
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="sb-engine-menu">
            {DICTIONARY_LIST.map((engine) => {
              // 10ten and Hachidori read Japanese only: listed, disabled, with the reason.
              const reason = dictionaryEngineLanguageReason(engine, dictionary.language.code)
              return (
                <SelectItem
                  key={engine}
                  value={engine}
                  disabled={reason !== null}
                  description={reason ?? DICTIONARY_ENGINES[engine].tagline}
                >
                  <DictionaryLabel engine={engine} />
                </SelectItem>
              )
            })}
          </SelectContent>
        </SelectRoot>
        {notice && (
          <SidebarNotice
            tone={notice.tone}
            action={readiness.download && readiness.download !== 'ready' ? 'Download in Settings' : 'Open dictionary settings'}
            onAction={onOpenSettings}
            title={notice.title}
          >
            {notice.text}
          </SidebarNotice>
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

/**
 * The OCR model only matters while the Log reads the screen or the browser extension's pictures,
 * or while OCR places the Text Hooker's card on the game (Auto align, kept per game).
 */
function useReadsScreen(): boolean {
  const [input, setInput] = useState(() => getSettings().inputSource)
  useEffect(() => onSettingsChange((next) => setInput(next.inputSource)), [])
  const hook = useHookStatus()
  const placement = useHookPlacement(input === 'hook' ? hook.exe : null)
  return input === 'ocr' || input === 'browser' || Boolean(placement?.on)
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
  /** Back out of Settings; none where Settings is a tab (Gaming Mode). */
  onBack?: () => void
  /** Bumped to open the source menu on its window grid. */
  chooseRequest: number
  mini?: boolean
  onChooseSource?: () => void
}): JSX.Element {
  // The width while a drag is in progress; the saved width otherwise.
  const [live, setLive] = useState<number | null>(null)
  const style = mini ? undefined : { width: live ?? width }
  const readsScreen = useReadsScreen()
  const { os } = useCapabilities()
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
          {onBack && (
            <Row icon={<ArrowLeft />} className="sb-back" onClick={onBack}>
              Back
            </Row>
          )}
          <nav className="sb-nav" aria-label="Settings pages">
            {settingsNavFor(os).map((item) => (
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
        <BrowserEngines />
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
