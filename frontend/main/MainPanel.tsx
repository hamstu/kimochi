/**
 * The main window: a resizable sidebar (source and session pickers, Settings at its foot) and the
 * current view: the Log, the Notebook or the session's Anki cards, switched by tabs across the
 * top, or Settings. The title
 * bar carries the sidebar toggle and the app's name.
 *
 * Steam Deck Gaming Mode has no sidebar, mini mode or sidebar toggle: the window is a full-screen
 * app used by touch. What the sidebar holds is the Source tab instead (GamingSourceView), the
 * first view, and Settings is a tab of its own; Settings' page list is the only sidebar left.
 *
 * The Log stays mounted under the other views: it owns line intake (clipboard, WebSocket, OCR),
 * scan mode and the built-in Yomitan lookups, none of which may stop because of a view.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type JSX
} from 'react'
import { CircleHelp, Maximize2, Minimize2, PanelLeft } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { IconButton, Tooltip } from '@kit'
import { ReaderHost, Transcript } from '@texthooker/App'
import { TitleBarPortal } from '../shell/TitleBarPortal'
import KimochiLogo from '../components/KimochiLogo'
import { useSetting } from '../bridge/useSetting'
import { isGamingMode, useCapabilities } from '../bridge/capabilities'
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
import { HelpDialog } from './HelpDialog'
import { useWhatsNewOnLaunch } from './whatsNewOnLaunch'
import '../panels/settings-panel.css'
import { GamingSourceView } from './GamingSourceView'
import { useBehindGame } from './useBehindGame'
import { panel } from '../bridge/tauri'
import { demoStops, inDemo } from '../bridge/demo'
import './main.css'
import { BootReady, rememberBootShape } from '../entries/boot'
import { loadedView, loadView, preloadViews, whenIdle } from './lazyViews'
import { preloadAllSettingsPagesWhenIdle } from '../panels/settings/settingsPages'

const LazyNotebook = lazy(() => loadView('notebook'))
const LazyAnkiCards = lazy(() => loadView('anki'))

// Preloaded after the first content (see lazyViews), a view renders at once; `lazy` alone would
// still suspend for a tick on its first show (the choice is made once per mount). The fallback is for a view opened before its chunk
// arrived, and appears only if that takes long enough to notice.
function Notebook(props: ComponentProps<typeof LazyNotebook>): JSX.Element {
  const [Ready] = useState(() => loadedView('notebook'))
  return Ready ? <Ready {...props} /> : <LazyNotebook {...props} />
}
function AnkiCards(): JSX.Element {
  const [Ready] = useState(() => loadedView('anki'))
  return Ready ? <Ready /> : <LazyAnkiCards />
}

/**
 * Beside BootReady, so it mounts with the window's real content: then, while idle, fetches the
 * other views' chunks (the Notebook and Anki cards, then the Settings pages) so switching to them
 * never shows a loading state.
 */
function PreloadViews(): null {
  useEffect(() => whenIdle(preloadViews), [])
  useEffect(preloadAllSettingsPagesWhenIdle, [])
  return null
}

function ViewLoading(): JSX.Element {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setShown(true), 150)
    return () => clearTimeout(id)
  }, [])
  return (
    <div className="main-view-loading" role="status">
      {shown && (
        <>
          <span className="k-spinner" aria-hidden="true" />
          <span className="sr-only">Loading</span>
        </>
      )}
    </div>
  )
}

/** Gaming Mode, as native says before the first frame (platform::platform_prelude). */
const gamingAtBoot = (): boolean =>
  Boolean((window as { __KIMOCHI_PLATFORM__?: { gamescope?: boolean } }).__KIMOCHI_PLATFORM__?.gamescope)

function initialView(): MainView {
  const view = new URLSearchParams(location.search).get('view')
  if (view === 'notebook' || view === 'anki' || view === 'settings') return view
  if (view === 'source' && gamingAtBoot()) return view
  // Reloaded by a dictionary-engine switch made in Settings: open on that page, not the Log.
  const switched = engineSwitchRecord()?.view
  if (switched && (switched !== 'source' || gamingAtBoot())) return switched
  // Gaming Mode starts where a reader sets up: the Source view.
  return gamingAtBoot() ? 'source' : 'log'
}

export default function MainPanel(): JSX.Element {
  const capabilities = useCapabilities()
  const gaming = isGamingMode(capabilities) || gamingAtBoot()
  useBehindGame(gaming)
  const [sidebar, setSidebar] = useSetting<boolean>('mainSidebarOpen', true)
  const [sidebarWidth, setSidebarWidth] = useSetting<number>('mainSidebarWidth', DEFAULT_WIDTH)
  // The next launch's first frame (panel.html) draws the sidebar where it will be.
  useEffect(() => rememberBootShape({ sidebar, sidebarWidth }), [sidebar, sidebarWidth])
  // `?view=` picks the first view (used by the UI preview pages).
  const [view, setViewState] = useState<MainView>(initialView)
  const [mini, setMini] = useState(false)
  const [miniError, setMiniError] = useState<string | null>(null)
  const changeMini = useCallback(async (enabled: boolean): Promise<void> => {
    try {
      await panel('log', enabled ? 'mini' : 'expand')
      setMini(enabled)
      document.documentElement.toggleAttribute('data-mini', enabled)
      setMiniError(null)
    } catch (error) {
      setMiniError(String(error))
    }
  }, [])
  useEffect(() => {
    const pending = listen<boolean>('main:mini', ({ payload }) => {
      setMini(payload)
      document.documentElement.toggleAttribute('data-mini', payload)
    })
    void panel('log', 'inspect')
      .then((info) => {
        const enabled = Boolean(info.mini)
        setMini(enabled)
        document.documentElement.toggleAttribute('data-mini', enabled)
      })
      .catch(() => {})
    return () => void pending.then((stop) => stop())
  }, [])
  // After an engine switch the stored page is known before the setting loads: the first frame
  // shows it rather than General.
  const [storedTab, setStoredTab] = useSetting<string>('settingsActiveTab', engineSwitchRecord()?.tab ?? 'general')
  const settingsTab = settingsTabOf(storedTab)
  const [editing, setEditing] = useState<string | null>(null)
  // Where Back returns to from Settings.
  const lastView = useRef<Exclude<MainView, 'settings'>>(
    engineSwitchRecord()?.back ?? (gamingAtBoot() ? 'source' : 'log')
  )
  const settingsScroll = useRef<HTMLDivElement>(null)
  const { props: controller, error, dismissError } = useController()
  // What's new opens on its own once, on the first launch of a new version.
  const [whatsNew, setWhatsNew] = useWhatsNewOnLaunch()
  const [help, setHelp] = useState(false)

  const setView = (next: MainView): void => {
    if (next === 'settings' && demoStops('Settings')) return
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
  // Another Settings page starts at its top, as each page does in the Settings window.
  const shownTab = useRef(settingsTab)
  useLayoutEffect(() => {
    if (shownTab.current === settingsTab) return
    shownTab.current = settingsTab
    if (settingsScroll.current) settingsScroll.current.scrollTop = 0
  }, [settingsTab])

  // Other windows (the tray, a pop-up) ask for Settings by event; the page is already stored.
  useEffect(() => {
    const pending = listen('main:show-settings', () => {
      if (demoStops('Settings')) return
      void changeMini(false).then(() => setViewState('settings'))
    })
    return () => void pending.then((stop) => stop())
  }, [changeMini])

  // ...and for one of the main views (`kimochi open log|notebook|anki`, cli/server.rs), which also
  // leaves Settings.
  useEffect(() => {
    const pending = listen<{ view?: string }>('main:show-view', ({ payload }) => {
      const next = payload?.view
      if (next !== 'log' && next !== 'notebook' && next !== 'anki') return
      void changeMini(false).then(() => setViewState(next))
    })
    return () => void pending.then((stop) => stop())
  }, [changeMini])

  // ...and for a new source: the sidebar's Change source menu, opened on its window grid.
  const [chooseRequest, setChooseRequest] = useState(0)
  useEffect(() => {
    const pending = listen('main:choose-source', () => {
      if (gaming) {
        setViewState('source')
      } else {
        void changeMini(false)
        void setSidebar(true)
        setViewState((current) => (current === 'settings' ? lastView.current : current))
      }
      setChooseRequest((count) => count + 1)
    })
    return () => void pending.then((stop) => stop())
  }, [setSidebar, changeMini, gaming])

  // ⌘1, ⌘2, ⌘3 and ⌘, switch views (Ctrl+1, Ctrl+2, Ctrl+3 and Ctrl+, off macOS).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isPrimaryModifier(event, capabilities)) return
      if (event.key === '1') setView('log')
      else if (event.key === '2') setView('notebook')
      else if (event.key === '3') setView('anki')
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
          {!mini && !gaming && (
            <Tooltip content={sidebar ? 'Hide sidebar' : 'Show sidebar'}>
              <IconButton
                label={sidebar ? 'Hide sidebar' : 'Show sidebar'}
                size="sm"
                className="main-sidebar-toggle"
                data-sound={sidebar ? 'sidebar-hide' : 'sidebar-show'}
                onClick={() => void setSidebar(!sidebar)}
              >
                <PanelLeft />
              </IconButton>
            </Tooltip>
          )}
          {!gaming && (
            <IconButton label={mini ? 'Expand Kimochi' : 'Mini mode'} size="sm" onClick={() => void changeMini(!mini)}>
              {mini ? <Maximize2 /> : <Minimize2 />}
            </IconButton>
          )}
          <span className="main-title" aria-hidden="true">
            <KimochiLogo size={16} />
            <span>Kimochi</span>
          </span>
          {/* Not on the site's demo: its forms would send real reports. */}
          {!inDemo() && (
            <Tooltip content="Help">
              <IconButton label="Help" size="sm" className="main-help" onClick={() => setHelp(true)}>
                <CircleHelp />
              </IconButton>
            </Tooltip>
          )}
        </TitleBarPortal>
        {miniError && (
          <div role="alert" className="native-panel-error" onClick={() => setMiniError(null)}>
            {miniError}
          </div>
        )}
        <div className="main-frame">
          {error && (
            <div className="native-panel-error" role="status" onClick={dismissError} title="Dismiss">
              {error}
            </div>
          )}
          {/* Gaming Mode: the tabs span the window, with Settings' page list under them. */}
          {gaming && <ViewTabs view={view} onView={setView} gaming />}
          <div className="main-layout">
            {(gaming ? view === 'settings' : sidebar || mini) && (
              <MainSidebar
                width={sidebarWidth}
                onResize={setSidebarWidth}
                view={mini && !gaming ? 'log' : view}
                mini={mini && !gaming}
                onChooseSource={() => {
                  void changeMini(false).then(() => {
                    void setSidebar(true)
                    setViewState(lastView.current)
                    setChooseRequest((count) => count + 1)
                  })
                }}
                controller={controller}
                onOpenSourceSettings={() => {
                  void changeMini(false).then(() => openSettings('sources'))
                }}
                chooseRequest={chooseRequest}
                settingsTab={settingsTab}
                onSettingsTab={(tab) => {
                  void changeMini(false).then(() => openSettings(tab))
                }}
                // Gaming Mode: Settings is a tab, so there is nothing to go back to.
                onBack={gaming ? undefined : () => setView(lastView.current)}
              />
            )}
            <div className="main-view" style={mini && !gaming ? { display: 'none' } : undefined}>
              {!gaming && view !== 'settings' && <ViewTabs view={view} onView={setView} />}
              {gaming && view === 'source' && (
                <GamingSourceView controller={controller} onOpenSettings={openSettings} chooseRequest={chooseRequest} />
              )}
              <Transcript visible={view === 'log'} onOpenNotebook={openNotebook} />
              {view === 'notebook' && (
                <Suspense fallback={<ViewLoading />}>
                  <Notebook
                    editingId={editing}
                    onEdit={setEditing}
                    onCloseEditor={() => setEditing(null)}
                    onShowLog={() => setView('log')}
                  />
                </Suspense>
              )}
              {view === 'anki' && (
                <Suspense fallback={<ViewLoading />}>
                  <AnkiCards />
                </Suspense>
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
        {!inDemo() && <HelpDialog open={help} onOpenChange={setHelp} />}
        <BootReady label="log" />
        <PreloadViews />
      </LogActionsProvider>
    </ReaderHost>
  )
}
