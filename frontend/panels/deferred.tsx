import { lazy } from 'react'

// Each native panel loads its own UI when first opened, rather than at main-window startup.
export const SettingsPanel = lazy(() => import('./SettingsPanel'))
export const DiagnosticsPanel = lazy(() => import('./DiagnosticsPanel'))
export const DictionarySettingsPanel = lazy(() => import('./DictionarySettingsPanel'))
export const SyncLogPanel = lazy(() => import('./SyncLogPanel'))
