/**
 * Panel window entry.
 *
 * Electron used one `panel.html` for every panel window and switched on the snapshot's `kind`
 * (`windows/panel/PanelApp.tsx`). Tauri windows carry a label instead, so this switches on
 * `getCurrentWindow().label` — the same single-shell arrangement.
 */
// First: one press per tap on WebKitGTK touchscreens, before any other listener.
import '@ui/install-pointer-dedupe'
import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { reportError, reportUncaughtErrors } from './reportErrors'
import { WindowErrorBoundary } from '../shell/WindowErrorBoundary'
import '../kit/kit.css'
import '../texthooker/App.css'
import '../shell/panel.css'
import Providers from './providers'
import PanelShell from '../shell/PanelShell'
import MainPanel from '../main/MainPanel'
import DictionaryPanelShell from '../shell/DictionaryPanelShell'
import { preloadPanelDictionary } from '../shell/panelDictionary'
import { BootReady, bootMark, bootReady } from './boot'
import { seedSettings } from '../bridge/useSetting'

import { SettingsPanel, DiagnosticsPanel, DictionarySettingsPanel, SyncLogPanel } from '../panels/deferred'

/** Titles and components, matching `PanelApp.tsx`'s `titles` / `components` maps. */
const PANELS = {
  log: { title: 'Kimochi', Component: MainPanel, hideTitle: true },
  settings: { title: 'Settings', Component: SettingsPanel, hideTitle: false },
  diagnostics: {
    title: 'Diagnostics',
    Component: DiagnosticsPanel,
    hideTitle: true
  },
  // Sync's activity, from Settings → Account → Sync.
  'sync-log': { title: 'Sync log', Component: SyncLogPanel, hideTitle: false },
  // Titled by the engine; see `DictionaryPanelShell`.
  dictionary: {
    title: 'Dictionary',
    Component: DictionarySettingsPanel,
    hideTitle: false
  }
} as const

type KnownLabel = keyof typeof PANELS

bootMark('modules')
const label = getCurrentWindow().label

reportUncaughtErrors(label)
const known = (label in PANELS ? label : 'log') as KnownLabel
const { title, Component, hideTitle } = PANELS[known]

if (!(label in PANELS)) {
  console.error(
    `[panel] window label "${label}" has no panel; falling back to the main window. Known labels: ${Object.keys(PANELS).join(', ')}`
  )
}

// The main window (the Log) hosts dictionary lookups over scanned text. The real backend lives in the
// overlay (one IndexedDB writer), so for Yomitan the overlay workstream ships a relay module that
// must publish this window's native label and install its chrome.* host BEFORE React mounts; for
// Hachidori and 10ten the injected extension host is already in place. `start()` is called
// separately, after the log content is in the DOM — see `usePanelDictionary` in the Log panel.
// The settings, read in one round trip that `panel.html` started before any module loaded, so the
// first render has the stored values rather than defaults that change a frame later. Bounded: a
// busy native side never holds the window back for long; hooks still load what was missed.
async function preloadSettings(): Promise<void> {
  const pending = (window as { __kimochiSettings?: Promise<unknown> }).__kimochiSettings
  if (!pending) return
  const all = await Promise.race([
    pending.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 400))
  ])
  if (all && typeof all === 'object') seedSettings(all as Record<string, unknown>)
}

await Promise.all([known === 'log' ? preloadPanelDictionary(label) : null, preloadSettings()])
bootMark('preloaded')

// Never leave the first frame over a window whose render failed or stalled.
setTimeout(() => bootReady(label), 10_000)

bootMark('render-start')
createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => reportError(label, 'render', error)
}).render(
  <StrictMode>
    {/* Outer layer, for the shell and providers themselves; PanelShell holds the inner one. */}
    <WindowErrorBoundary window={label}>
      <Providers>
        <Suspense fallback={<div role="status">Loading…</div>}>
          {known === 'dictionary' ? (
            // The dictionary window's title follows the active engine.
            <DictionaryPanelShell label={label} hideTitle={hideTitle}>
              <Component />
            </DictionaryPanelShell>
          ) : (
            <PanelShell label={label} title={title} hideTitle={hideTitle}>
              <Component />
            </PanelShell>
          )}
          {/* The main window's content is ready once its log has loaded (MainPanel). */}
          {known !== 'log' && <BootReady label={label} />}
        </Suspense>
      </Providers>
    </WindowErrorBoundary>
  </StrictMode>
)
