/** One settings page by name, for the Settings window and the main window's Settings view. */
import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import type { SettingsTabName } from '../../bridge/tauri'
import { loadedSettingsPage, loadSettingsPage, preloadAllSettingsPagesWhenIdle } from './settingsPages'
// The page scroller's styles. Imported here, not only by the Settings window's shell, because the
// main window hosts pages too and must not depend on the (lazy) Settings window to bring them.
import './settings-shell.css'

// A page that has already arrived (preloaded, or shown before) renders at once: `lazy` alone would
// suspend for a tick and swap the old page for an empty pane. The choice is made once per mount.
function page(tab: SettingsTabName): ComponentType {
  const Lazy = lazy(() => loadSettingsPage(tab))
  return function SettingsPage(): ReactNode {
    const [Ready] = useState(() => loadedSettingsPage(tab))
    return Ready ? <Ready /> : <Lazy />
  }
}
const PAGES: Record<SettingsTabName, ComponentType> = {
  general: page('general'),
  sources: page('sources'),
  ocr: page('ocr'),
  log: page('log'),
  dictionary: page('dictionary'),
  assist: page('assist'),
  controls: page('controls'),
  account: page('account')
}

/** Shown while a page's chunk loads, only once that takes long enough to notice. */
const LOADING_DELAY_MS = 150

function PageLoading(): ReactNode {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setShown(true), LOADING_DELAY_MS)
    return () => clearTimeout(id)
  }, [])
  return (
    <div className="settings-page-loading" role="status">
      {shown && (
        <>
          <span className="k-spinner" aria-hidden="true" />
          <span className="sr-only">Loading settings</span>
        </>
      )}
    </div>
  )
}

/** Mounts with the first page that renders, then fetches the other pages while idle. */
function PageLoaded({ children }: { children: ReactNode }): ReactNode {
  useEffect(preloadAllSettingsPagesWhenIdle, [])
  return children
}

export function SettingsPageFor({ tab }: { tab: SettingsTabName }): ReactNode {
  const Page = PAGES[tab]
  return (
    <Suspense fallback={<PageLoading />}>
      <PageLoaded>
        <Page />
      </PageLoaded>
    </Suspense>
  )
}
