/**
 * The settings pages' chunks. Pages load when Settings first shows; once one has rendered, the
 * rest are fetched while the window is idle (and a page's chunk on hover over its nav row), so
 * later switches are instant. Nothing here runs at startup.
 */
import type { ComponentType } from 'react'
import type { SettingsTabName } from '../../bridge/tauri'

type PageModule = Promise<{ default: ComponentType }>

const LOADERS: Record<SettingsTabName, () => PageModule> = {
  general: () => import('./GeneralTab').then((m) => ({ default: m.GeneralTab })),
  sources: () => import('./SourcesTab').then((m) => ({ default: m.SourcesTab })),
  ocr: () => import('./OcrTab').then((m) => ({ default: m.OcrTab })),
  log: () => import('./LogTab').then((m) => ({ default: m.LogTab })),
  dictionary: () => import('./DictionaryTab').then((m) => ({ default: m.DictionaryTab })),
  assist: () => import('./AssistTab').then((m) => ({ default: m.AssistTab })),
  controls: () => import('./ControlsTab').then((m) => ({ default: m.ControlsTab })),
  account: () => import('./AccountTab').then((m) => ({ default: m.AccountTab })),
  about: () => import('./AboutTab').then((m) => ({ default: m.AboutTab }))
}

// One request per page, shared by `lazy` and the preloads; and the pages that have arrived.
const pending = new Map<SettingsTabName, PageModule>()
const loaded = new Map<SettingsTabName, ComponentType>()

/** A page that has already arrived, to render without suspending; otherwise undefined. */
export function loadedSettingsPage(tab: SettingsTabName): ComponentType | undefined {
  return loaded.get(tab)
}

/** A page's module, fetched once (a failed fetch is retried by the next call). */
export function loadSettingsPage(tab: SettingsTabName): PageModule {
  let module = pending.get(tab)
  if (!module) {
    module = LOADERS[tab]()
    module.then(
      (m) => loaded.set(tab, m.default),
      () => pending.delete(tab)
    )
    pending.set(tab, module)
  }
  return module
}

/** Fetches a page's chunk ahead of its first show (nav hover or focus). Unknown names are ignored. */
export function preloadSettingsPage(tab: string): void {
  if (Object.hasOwn(LOADERS, tab)) void loadSettingsPage(tab as SettingsTabName).catch(() => undefined)
}

let preloadedAll = false

/** Fetches every page once the window is idle; returns a cancel for an effect's cleanup. */
export function preloadAllSettingsPagesWhenIdle(): () => void {
  if (preloadedAll) return () => undefined
  const run = (): void => {
    preloadedAll = true
    for (const tab of Object.keys(LOADERS)) preloadSettingsPage(tab)
  }
  // WebKit (macOS, Linux) has no requestIdleCallback.
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(run, { timeout: 2000 })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(run, 500)
  return () => clearTimeout(id)
}
