/**
 * The main window: a resizable sidebar (source and session pickers, Settings at its foot) and the
 * current view: the Log or the Notebook, switched by tabs across the top, or Settings. The title
 * bar carries the sidebar toggle and the app's name.
 *
 * The Log stays mounted under the other views: it owns line intake (clipboard, WebSocket, OCR),
 * scan mode and the built-in Yomitan lookups, none of which may stop because of a view.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { PanelLeft } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { IconButton, Tooltip } from '@kit'
import { ReaderHost, Transcript } from '@texthooker/App'
import { NotebookPanel as Notebook } from '@texthooker/components/NotebookPanel'
import { TitleBarPortal } from '../shell/TitleBarPortal'
import KimochiLogo from '../components/KimochiLogo'
import { useSetting } from '../bridge/useSetting'
import { useCapabilities } from '../bridge/capabilities'
import { isPrimaryModifier } from '../panels/settings/accelerator'
import type { SettingsTabName } from '../bridge/tauri'
import { ReaderSettingsProvider } from '../panels/settings/ReaderSettingsProvider'
import { SettingsPageFor } from '../panels/settings/SettingsPageFor'
import { settingsTabOf } from '../panels/settings/settingsNav'
import { useController } from '../panels/useController'
import { ViewTabs } from './ViewTabs'
import { LogActionsProvider } from './LogActionsProvider'
import { engineSwitchRecord, registerMainRoute } from './engineSwitch'
import { DEFAULT_WIDTH, MainSidebar, type MainView } from './MainSidebar'
import { WhatsNewDialog } from './WhatsNewDialog'
import { useWhatsNewOnLaunch } from './whatsNewOnLaunch'
import '../panels/settings-panel.css'
import './main.css'

function initialView(): MainView {
  const view = new URLSearchParams(location.search).get('view')
  if (view === 'notebook' || view === 'settings') return view
  // Reloaded by a dictionary-engine switch made in Settings: open on that page, not the Log.
  return engineSwitchRecord()?.view ?? 'log'
}

export default function MainPanel(): JSX.Element {
  const [sidebar, setSidebar] = useSetting<boolean>('mainSidebarOpen', true)
  const [sidebarWidth, setSidebarWidth] = useSetting<number>('mainSidebarWidth', DEFAULT_WIDTH)
  // `?view=` picks the first view (used by the UI preview pages).
  const [view, setViewState] = useState<MainView>(initialView)
  // After an engine switch the stored page is known before the setting loads: the first frame
  // shows it rather than General.
  const [storedTab, setStoredTab] = useSetting<string>(
    'settingsActiveTab',
    engineSwitchRecord()?.tab ?? 'general'
  )
  const settingsTab = settingsTabOf(storedTab)
  const [editing, setEditing] = useState<string | null>(null)
  // Where Back returns to from Settings.
  const lastView = useRef<Exclude<MainView, 'settings'>>(engineSwitchRecord()?.back ?? 'log')
  const settingsScroll = useRef<HTMLDivElement>(null)
  const { props: controller, error, dismissError } = useController()
  // What's new opens on its own once, on the first launch of a new version.
  const [whatsNew, setWhatsNew] = useWhatsNewOnLaunch()

  const setView = (next: MainView): void => {
    if (next !== 'settings') lastView.current = next
    setViewState(next)
  }
  const openSettings = (tab: SettingsTabName): void => {
    void setStoredTab(tab)
    setView('settings')
  }
  const openNotebook = (entryId?: string): void => {
    setView('notebook')
    if (entryId) setEditing(entryId)
  }

  useEffect(() => {
    const back = (event: Event): void => {
      if (editing !== null) { setEditing(null); event.preventDefault() }
      else if (view === 'settings') { setViewState(lastView.current); event.preventDefault() }
    }
    document.addEventListener('kimochi:controller-back', back)
    return () => document.removeEventListener('kimochi:controller-back', back)
  }, [view, editing])

  // A switch of dictionary engine reloads this window; it records where Settings was first.
  const tabNow = useRef(settingsTab)
  useEffect(() => {
    tabNow.current = settingsTab
  }, [settingsTab])
  useEffect(
    () =>
      registerMainRoute(() => ({
        tab: tabNow.current,
        back: lastView.current,
        scrollTop: settingsScroll.current?.scrollTop ?? 0
      })),
    []
  )
  // ...and puts the Settings page back where it was scrolled to, once, before the first paint.
  useLayoutEffect(() => {
    const top = engineSwitchRecord()?.scrollTop ?? 0
    const scroller = settingsScroll.current
    if (!top || !scroller) return
    scroller.scrollTop = top
    // Sections that render from a setting still loading can be short on the first frame.
    const frame = requestAnimationFrame(() => {
      if (scroller.scrollTop < top) scroller.scrollTop = top
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  // Other windows (the tray, a pop-up) ask for Settings by event; the page is already stored.
  useEffect(() => {
    const pending = listen('main:show-settings', () => setViewState('settings'))
    return () => void pending.then((stop) => stop())
  }, [])

  // ...and for a new source: the sidebar's Change source menu, opened on its window grid.
  const [chooseRequest, setChooseRequest] = useState(0)
  useEffect(() => {
    const pending = listen('main:choose-source', () => {
      void setSidebar(true)
      setViewState((current) => (current === 'settings' ? lastView.current : current))
      setChooseRequest((count) => count + 1)
    })
    return () => void pending.then((stop) => stop())
  }, [setSidebar])

  // ⌘1, ⌘2 and ⌘, switch views (Ctrl+1, Ctrl+2 and Ctrl+, off macOS).
  const capabilities = useCapabilities()
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isPrimaryModifier(event, capabilities)) return
      if (event.key === '1') setView('log')
      else if (event.key === '2') setView('notebook')
      else if (event.key === ',') setView('settings')
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [capabilities])

  return (
    <ReaderHost>
      <LogActionsProvider>
        <TitleBarPortal>
          <Tooltip content={sidebar ? 'Hide sidebar' : 'Show sidebar'}>
            <IconButton
              label={sidebar ? 'Hide sidebar' : 'Show sidebar'}
              size="sm"
              className="main-sidebar-toggle"
              onClick={() => void setSidebar(!sidebar)}
            >
              <PanelLeft />
            </IconButton>
          </Tooltip>
          <span className="main-title" aria-hidden="true">
            <KimochiLogo size={16} />
            <span>Kimochi</span>
          </span>
        </TitleBarPortal>
        <div className="main-frame">
          {error && (
            <div
              className="native-panel-error"
              role="status"
              onClick={dismissError}
              title="Dismiss"
            >
              {error}
            </div>
          )}
          <div className="main-layout">
            {sidebar && (
              <MainSidebar
                width={sidebarWidth}
                onResize={setSidebarWidth}
                view={view}
                controller={controller}
                onOpenSourceSettings={() => openSettings('sources')}
                chooseRequest={chooseRequest}
                settingsTab={settingsTab}
                onSettingsTab={openSettings}
                onBack={() => setView(lastView.current)}
              />
            )}
            <div className="main-view">
              {view !== 'settings' && <ViewTabs view={view} onView={setView} />}
              <Transcript visible={view === 'log'} onOpenNotebook={openNotebook} />
              {view === 'notebook' && (
                <Notebook
                  editingId={editing}
                  onEdit={setEditing}
                  onCloseEditor={() => setEditing(null)}
                />
              )}
              {view === 'settings' && (
                <ReaderSettingsProvider>
                  <div ref={settingsScroll} className="settings-page-scroll main-settings">
                    <SettingsPageFor tab={settingsTab} />
                  </div>
                </ReaderSettingsProvider>
              )}
            </div>
          </div>
        </div>
        <WhatsNewDialog open={whatsNew} onOpenChange={setWhatsNew} />
      </LogActionsProvider>
    </ReaderHost>
  )
}
