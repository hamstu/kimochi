/**
 * The active dictionary engine, as the React windows see it (DICTIONARY_ENGINES.md §2).
 *
 * Two readings exist, on purpose:
 * - the SETTING (`yomitanSettings.popupType`) is the source of truth and what Settings, the
 *   dictionary panel and onboarding render from (`useDictionaryEngine`);
 * - the DOCUMENT-START engine (`documentEngine`) is what the injected host scripts resolved when
 *   this document loaded, from the `localStorage` mirror or native's prelude. It decides which
 *   host is installed in this document, so code that talks to a host (the Log's lookup) must use
 *   it, not the setting: after a switch the setting changes at once, but the host only changes
 *   when `dictionary_engine_apply` reloads the window.
 */
import { invoke } from '@tauri-apps/api/core'
import {
  DICTIONARY_ENGINE_KEY,
  DICTIONARY_ENGINES,
  NO_ENGINE,
  NO_ENGINE_MESSAGE,
  SETTINGS_DEFAULTS,
  dictionaryEngineOf,
  hostEngineOf,
  popupTypeOf,
  resolveHostEngine,
  type DictionaryEngine,
  type DictionaryEngineInfo,
  type HostEngine
} from '@ui/settings'
import type { YomitanSettings } from '../vendor/shared-types'
import { useSetting } from './useSetting'
import { panel } from './tauri'

export { DICTIONARY_ENGINES, NO_ENGINE, NO_ENGINE_MESSAGE, dictionaryEngineOf, hostEngineOf, popupTypeOf }
export type { DictionaryEngine, DictionaryEngineInfo, HostEngine }

/** The engines the extension host runs; the others have no `__kimochiExtensionHost`. */
export type ExtensionEngine = 'hachidori' | 'tenten'

export const isExtensionEngine = (engine: DictionaryEngine): engine is ExtensionEngine =>
  engine === 'hachidori' || engine === 'tenten'

/** `window.__kimochiExtensionHost` (host/ext, DICTIONARY_ENGINES.md §5.5). */
export interface ExtensionHost {
  engine: ExtensionEngine
  /** Resolves with a status and never rejects; calling it again returns the same outcome. */
  start: (options: { host: boolean; scope: string | null }) => Promise<{ ready: boolean; error?: string }>
  setEnabled: (enabled: boolean) => void
  observePopup: (onChange: (popup: { visible: boolean; rect: DOMRect | null }) => void) => () => void
  lookupRange: (range: Range) => Promise<boolean>
  popupControl: (control: { scroll?: number; step?: number }) => void
  dismiss: () => void
  isPopupVisible: () => boolean
  openOptionsPage: () => void
  ready: Promise<unknown>
  /** A navigation the dictionary window was asked for before React mounted. */
  pendingNavigate?: string | null
}

interface EngineGlobals {
  __kimochiDictionaryEngine?: string
  __kimochiExtensionOrigins?: Partial<Record<ExtensionEngine, string>>
  __kimochiExtensionHost?: ExtensionHost
}

const globals = (): EngineGlobals => window as unknown as EngineGlobals

function readMirror(): string | null {
  try {
    return localStorage.getItem(DICTIONARY_ENGINE_KEY)
  } catch {
    // Storage can be unavailable (a locked-down webview); native's prelude value still applies.
    return null
  }
}

/**
 * The engine whose host this document's scripts installed at document start: Yomitan, Hachidori
 * or 10ten (Kimochi's pop-up runs over the Yomitan host; see `hostEngineOf`), or `'none'` when the
 * selected engine was not downloaded and no host installed.
 */
export function documentEngine(): HostEngine {
  return resolveHostEngine(readMirror(), globals().__kimochiDictionaryEngine)
}

/** The setting a document's engine stands for, as a placeholder until the real one loads. */
export const documentPlaceholder = (): DictionaryEngine => {
  const engine = documentEngine()
  return engine === NO_ENGINE ? 'yomitan' : engine
}

/**
 * Writes the document-start mirror, so windows (re)loaded from now on install that engine's host.
 * Kimochi's pop-up is mirrored as Yomitan, whose host it runs over (`hostEngineOf`).
 */
export function mirrorDictionaryEngine(engine: DictionaryEngine): void {
  try {
    localStorage.setItem(DICTIONARY_ENGINE_KEY, hostEngineOf(engine))
  } catch (error) {
    // Native's prelude carries the setting too, so a failed write degrades rather than breaks.
    console.warn('[dictionary] could not write the engine mirror:', error)
  }
}

/** Reloads the windows that host a dictionary engine; see `dictionary_engine_apply`. */
export const applyDictionaryEngine = (): Promise<void> => invoke('dictionary_engine_apply')

/** The extension's own origin (`hachidori://localhost`, …), or null outside a Kimochi window. */
export function extensionOrigin(engine: ExtensionEngine): string | null {
  return globals().__kimochiExtensionOrigins?.[engine]?.replace(/\/$/, '') ?? null
}

/** This document's extension host, when one installed. */
export const extensionHost = (): ExtensionHost | null => globals().__kimochiExtensionHost ?? null

/** The `dictionary` window's title for an engine. */
export function dictionaryPanelTitle(engine: DictionaryEngine): string {
  return engine === 'custom-api' ? 'Dictionary' : `${DICTIONARY_ENGINES[engine].name} settings`
}

/** Shows the `dictionary` panel: the active engine's own settings. */
export const openDictionarySettings = (): Promise<unknown> => panel('dictionary', 'show')

/** The engine the setting names, live. */
export function useDictionaryEngine(): [DictionaryEngine, YomitanSettings, (value: YomitanSettings) => Promise<void>] {
  // Until the setting loads, assume the engine this document's host was installed for (the
  // mirror or native's prelude) rather than the shipped default: a Hachidori user's dictionary
  // window otherwise shows "Switching to Yomitan…" for a beat, and onboarding mounts Yomitan's
  // importer, whose first request then fails.
  const [settings, setSettings] = useSetting<YomitanSettings>('yomitanSettings', {
    ...SETTINGS_DEFAULTS.yomitanSettings,
    popupType: popupTypeOf(documentPlaceholder())
  })
  return [dictionaryEngineOf(settings.popupType), settings, setSettings]
}
