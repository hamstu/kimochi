/**
 * The main window: a resizable sidebar (source and session pickers, Settings at its foot) and the
 * current view: the Log or the Notebook, switched by tabs across the top, or Settings. The title
 * bar carries the sidebar toggle and the app's name.
 *
 * The Log stays mounted under the other views: it owns line intake (clipboard, WebSocket, OCR),
 * scan mode and the built-in Yomitan lookups, none of which may stop because of a view.
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { PanelLeft } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { IconButton, Tooltip } from '@kit'
import { ReaderHost, Transcript } from '@texthooker/App'
import { NotebookPanel as Notebook } from '@texthooker/components/NotebookPanel'
import { TitleBarPortal } from '../shell/TitleBarPortal'
import { useSetting } from '../bridge/useSetting'
import type { SettingsTabName } from '../bridge/tauri'
import { ReaderSettingsProvider } from '../panels/settings/ReaderSettingsProvider'
import { SettingsPageFor } from '../panels/settings/SettingsPageFor'
import { settingsTabOf } from '../panels/settings/settingsNav'
import { useController } from '../panels/useController'
import { ViewTabs } from './ViewTabs'
import { LogActionsProvider } from './LogActionsProvider'
import { DEFAULT_WIDTH, MainSidebar, type MainView } from './MainSidebar'
import '../panels/settings-panel.css'
import './main.css'

function initialView(): MainView {
  const view = new URLSearchParams(location.search).get('view')
  return view === 'notebook' || view === 'settings' ? view : 'log'
}

export default function MainPanel(): JSX.Element {
  const [sidebar, setSidebar] = useSetting<boolean>('mainSidebarOpen', true)
  const [sidebarWidth, setSidebarWidth] = useSetting<number>('mainSidebarWidth', DEFAULT_WIDTH)
  // `?view=` picks the first view (used by the UI preview pages).
  const [view, setViewState] = useState<MainView>(initialView)
  const [storedTab, setStoredTab] = useSetting<string>('settingsActiveTab', 'general')
  const settingsTab = settingsTabOf(storedTab)
  const [editing, setEditing] = useState<string | null>(null)
  // Where Back returns to from Settings.
  const lastView = useRef<Exclude<MainView, 'settings'>>('log')
  const { props: controller, error, dismissError } = useController()

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

  // Other windows (the tray, a pop-up) ask for Settings by event; the page is already stored.
  useEffect(() => {
    const pending = listen('main:show-settings', () => setViewState('settings'))
    return () => void pending.then((stop) => stop())
  }, [])

  // ⌘1, ⌘2 and ⌘, switch views.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
      if (event.key === '1') setView('log')
      else if (event.key === '2') setView('notebook')
      else if (event.key === ',') setView('settings')
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
          <span className="main-title">kimochi</span>
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
                  <div className="settings-page-scroll main-settings">
                    <SettingsPageFor tab={settingsTab} />
                  </div>
                </ReaderSettingsProvider>
              )}
            </div>
          </div>
        </div>
      </LogActionsProvider>
    </ReaderHost>
  )
}
