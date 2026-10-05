/**
 * Typed client for the native backend described in `COMMANDS.md` (owner: kimochi-native).
 *
 * One wrapper per command. Errors from Rust are strings carrying a machine-readable prefix
 * (`busy:`, `permission:`, `gone:`, `invalid:`, `native:`); `nativeError()` parses them so callers
 * can branch, and every panel shows the human-facing remainder rather than swallowing it.
 *
 * Shared with the overlay workstream — do not fork this file.
 */
import { invoke } from '@tauri-apps/api/core'
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  CaptureFrame,
  DisplayInfo,
  CaptureRequest,
  HotkeysSettings,
  NativeErrorKind,
  NativeSource,
  PanelAction,
  PanelInfo,
  PanelLabel,
  PlatformCapabilities,
  Rect,
  ScanResult,
  SystemState,
  ViewState
} from './types'

export interface NativeError {
  kind: NativeErrorKind
  message: string
  raw: string
}

const PREFIXES: NativeErrorKind[] = ['busy', 'permission', 'gone', 'invalid', 'native']

/** Parses a rejected invoke into its machine-readable kind plus the human-facing text. */
export function nativeError(error: unknown): NativeError {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : (() => {
            try {
              return JSON.stringify(error)
            } catch {
              return String(error)
            }
          })()
  for (const kind of PREFIXES) {
    if (raw.startsWith(`${kind}:`)) {
      return { kind, message: raw.slice(kind.length + 1).trim(), raw }
    }
  }
  return { kind: 'unknown', message: raw, raw }
}

/** `busy:` means the single capture mutex is held; retrying is always safe. */
export const isBusy = (error: unknown): boolean => nativeError(error).kind === 'busy'

/** Retries a call while the backend reports `busy:`. Any other failure propagates immediately. */
export async function retryWhileBusy<T>(
  call: () => Promise<T>,
  attempts = 4,
  delayMs = 250
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await call()
    } catch (error) {
      lastError = error
      if (!isBusy(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)))
    }
  }
  throw lastError
}

// ---------------------------------------------------------------------------- settings

export const settingsGet = <T>(key: string): Promise<T | null> =>
  invoke<T | null>('settings_get', { key })
export const settingsSet = (key: string, value: unknown): Promise<void> =>
  invoke('settings_set', { key, value })
export const settingsAll = (): Promise<Record<string, unknown>> =>
  invoke<Record<string, unknown>>('settings_all')
export const onSettingsChanged = (
  handler: (key: string, value: unknown) => void
): Promise<UnlistenFn> =>
  listen<{ key: string; value: unknown }>('settings:changed', (event) =>
    handler(event.payload.key, event.payload.value)
  )

// ---------------------------------------------------------------------------- panels

export const panel = (
  label: PanelLabel | string,
  action: PanelAction,
  rect: Rect | null = null
): Promise<PanelInfo> => invoke<PanelInfo>('panel', { label, action, rect })
/** Settings pages, in rail order. Older builds stored other names; see `settingsTabOf`. */
export type SettingsTabName =
  'general' | 'sources' | 'ocr' | 'log' | 'dictionary' | 'assist' | 'controls'

/** Shows Settings, on one page when given: a view of the main window. */
export async function openSettings(tab?: SettingsTabName): Promise<void> {
  if (tab) await settingsSet('settingsActiveTab', tab)
  await panel('log', 'show')
  await emit('main:show-settings', {})
}

export const panelContentHeight = (label: string, height: number): Promise<void> =>
  invoke('panel_content_height', { label, height })
export const panelPointer = (): Promise<[number, number] | null> =>
  invoke<[number, number] | null>('panel_pointer')
export const panelCursor = (kind: string): Promise<void> => invoke('panel_cursor', { kind })

// ---------------------------------------------------------------------------- state

export const snapshot = (): Promise<ViewState> => invoke<ViewState>('snapshot')
export const systemState = (): Promise<SystemState> => invoke<SystemState>('system_state')
export const desktop = (): Promise<Rect[]> => invoke<Rect[]>('desktop')
/** Richer than `desktop()`: carries each display's id, work area and scale factor. */
export const displays = (): Promise<DisplayInfo[]> => invoke<DisplayInfo[]>('displays')
/** What this machine can do; prefer `loadCapabilities()`, which caches and never rejects. */
export const platformCapabilities = (): Promise<PlatformCapabilities> =>
  invoke<PlatformCapabilities>('platform_capabilities')

// ---------------------------------------------------------------------------- capture / OCR

export const enumerateSources = (): Promise<NativeSource[]> => invoke<NativeSource[]>('enumerate')
export const requestPermission = (): Promise<boolean> => invoke<boolean>('permission')
export const captureFrame = (request: CaptureRequest): Promise<CaptureFrame> =>
  invoke<CaptureFrame>('capture_frame', { request })
export const scan = (request: CaptureRequest, ocr: boolean): Promise<ScanResult> =>
  invoke<ScanResult>('scan', { request, ocr })
export const clearScan = (): Promise<void> => invoke('clear')

// ---------------------------------------------------------------------------- source picker

export const sourceCatalog = (): Promise<NativeSource[]> => invoke<NativeSource[]>('source_catalog')
export const sourceThumbnail = (sourceId: string): Promise<{ url: string }> =>
  invoke<{ url: string }>('source_thumbnail', { sourceId })
/** The chosen source as it looks right now, uncached; `busy:` while a scan holds the capture. */
export const sourceLiveThumbnail = (
  sourceId: string
): Promise<{ url: string; width: number; height: number }> =>
  invoke('source_live_thumbnail', { sourceId })
/** An application's icon as a data URL, or null when it has none. Natively cached per app. */
export const sourceIcon = (appName: string): Promise<{ icon: string | null }> =>
  invoke<{ icon: string | null }>('source_icon', { appName })
/** Read this window or display, keeping the region saved for it. */
export const selectSource = (sourceId: string): Promise<void> =>
  invoke('commit_source', { sourceId, crop: null, keepCrop: true })
/** Forget the source's region: the whole window or display is read. */
export const clearSourceCrop = (sourceId: string): Promise<void> =>
  invoke('commit_source', { sourceId, crop: null, keepCrop: false })
/** Bring a window source's application to the front. */
export const activateSource = (sourceId: string): Promise<void> =>
  invoke('activate_source', { sourceId })
/** The main window, with its source menu open on the grid of windows and displays. */
export const openSourcePicker = (): Promise<void> => invoke('open_source_picker')

// ---------------------------------------------------------------------------- actions

/**
 * Single entry point for controller/tray/hotkey actions, as agreed with the overlay workstream.
 * The overlay owns the OCR orchestration behind `triggerScan` and the auto-OCR loop.
 */
export const triggerAction = (name: string): Promise<void> => invoke('trigger_action', { name })

export const quitApp = (): Promise<void> => invoke('app_quit')
export const openDictionary = (open: boolean): Promise<void> => invoke('dictionary', { open })
export const texthookerSend = (text: string): Promise<void> => invoke('texthooker_send', { text })
export const openScreenCapturePreferences = (): Promise<void> =>
  invoke('open_screen_capture_preferences')
export const openAccessibilityPreferences = (): Promise<void> =>
  invoke('open_accessibility_preferences')

/** Session flags the owning window sets directly (see `view_flags` in the backend). */
export const setViewFlags = (flags: Record<string, boolean>): Promise<void> =>
  invoke('view_flags', { flags })

export const historyAdd = (text: string): Promise<unknown> => invoke('history_add', { text })
export const historyDelete = (id: string): Promise<void> => invoke('history_delete', { id })
export const historyClear = (): Promise<void> => invoke('history_clear')

// ---------------------------------------------------------------------------- hotkeys

export const hotkeysLoad = (): Promise<HotkeysSettings> => invoke<HotkeysSettings>('hotkeys_load')
export const hotkeysSave = (hotkeys: HotkeysSettings): Promise<void> =>
  invoke('hotkeys_save', { hotkeys })
export interface HotkeysApplyResult {
  registered: string[]
  failed: { name: string; accelerator: string; error: string }[]
  /** True while recording has the shortcuts paused; `failed` is then not meaningful. */
  suspended?: boolean
  /** Set when a restore found nothing paused, so the report says nothing about the set. */
  unchanged?: boolean
}
export const hotkeysReapply = (): Promise<HotkeysApplyResult> => invoke('hotkeys_reapply')
/** Pause (or restore) every global shortcut and gamepad action while a new binding is recorded. */
export const hotkeysSuspend = (suspended: boolean): Promise<HotkeysApplyResult | undefined> =>
  invoke('hotkeys_suspend', { suspended })

// ---------------------------------------------------------------------------- events

export const onEvent = <T>(name: string, handler: (payload: T) => void): Promise<UnlistenFn> =>
  listen<T>(name, (event) => handler(event.payload))
