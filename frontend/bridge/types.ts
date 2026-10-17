/**
 * Shared payload types for the native contract (`COMMANDS.md`).
 *
 * Importable by the overlay workstream as well as the panels — one definition per payload, so the
 * two frontends cannot drift. Types that exist unchanged in the Electron app are re-exported from
 * `../vendor/shared-types` rather than redefined.
 */
export type {
  CropRegion,
  TextAnnotation,
  GoogleVisionOCRResult,
  ScanHistoryEntry,
  HotkeyDefinition,
  HotkeysSettings,
  HotkeyOverrides,
  YomitanSettings,
  PopupType,
  AudioSettings,
  AutoScanSettings,
  AutoOCRSettings,
  TextOverlayGroupingSettings,
  TexthookerSettings,
  ServerSettings,
  GamepadDevice,
  GamepadState,
  GamepadSettings,
  LastSelectedSource,
  TokenizedTerm,
  TokenizeResponse,
  WindowPosition
} from '../vendor/shared-types'

/** macOS desktop points, top-left origin. May be negative on secondary displays. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Integer pixels against the saved reference frame; each axis rescales independently. */
export interface NativeCrop {
  x: number
  y: number
  width: number
  height: number
  reference_width: number
  reference_height: number
}

export interface CaptureRequest {
  source_id: string
  crop: NativeCrop | null
}

export type PanelLabel =
  | 'log'
  | 'settings'
  | 'diagnostics'
  | 'dictionary'
  | 'tray-popover'
  | 'welcome'
  | 'overlay'
  | 'fixture'
  | 'fixture-chunks'
  | 'sync-log'

export type PanelAction =
  | 'show'
  | 'hide'
  | 'drag'
  | 'place'
  | 'minimize'
  | 'restore'
  | 'pin'
  | 'unpin'
  | 'inspect'
  | 'mini'
  | 'expand'

export interface PanelInfo {
  mini?: boolean
  label: string
  native: { level: number; opaque: boolean; ignores_mouse: boolean }
  bounds: Rect
  scale: number
  pinned: boolean
  focused: boolean
  resizable: boolean
}

export interface PanelStateEvent {
  label: string
  visible: boolean
  pinned: boolean
  bounds: Rect
}

export interface NativeSource {
  id: string
  kind: 'display' | 'window' | string
  name: string
  app?: string | null
  bounds?: Rect
  on_screen?: boolean
  icon?: string | null
}

export interface CaptureInfo {
  source_id: string
  width: number
  height: number
  full_width: number
  full_height: number
  [key: string]: unknown
}

export interface CaptureFrame {
  id: number
  info: CaptureInfo
  url: string
}

export interface ScanResult {
  id: number
  info: CaptureInfo
  ocr: import('../vendor/shared-types').GoogleVisionOCRResult | null
}

/**
 * `snapshot()`. The controller and tray read their whole enabled/disabled state from this, so the
 * fields beyond the POC's original set were requested from kimochi-native (see FRONTEND_PLAN §7 H).
 * Every added field is optional here so the panels degrade to a usable state rather than crashing
 * if the backend has not shipped it yet.
 */
export interface ApplicationContext {
  id: string
  name: string
  provider: string
  manual: boolean
}

export interface ViewState {
  applicationContext?: ApplicationContext | null
  revision: number
  status: string
  scan: ScanResult | null
  logs: unknown[]
  /** Interactive rectangles, keyed by the window that owns them. */
  regions: Record<string, Rect[]>
  /**
   * Whether the captured window is still the frontmost ordinary window and still on
   * screen. `held` means one of Kimochi's own windows is in front, so the previous
   * answer is standing rather than being recomputed.
   */
  sourceFocus?: { focused: boolean; present: boolean; held: boolean; covered?: boolean }
  origin: Rect | null
  interactive: boolean
  dictionary: boolean
  dismiss: number
  source?: {
    sourceId: string
    type: 'screen' | 'window'
    name: string
    appName?: string | null
    icon?: string | null
    applicationContext?: ApplicationContext | null
  } | null
  crop?: NativeCrop | null
  cropEnabled?: boolean
  isScanning?: boolean
  autoOcrEnabled?: boolean
  overlayVisible?: boolean
  textOverlayVisible?: boolean
  debugOverlayVisible?: boolean
  /** macOS is throttling the overlay's drawing (Game Mode, with a full-screen game in front). */
  overlayThrottled?: boolean
  permission?: 'granted' | 'denied' | 'unknown'
  /** Raw and unfiltered; consumers decide what Kimochi's own windows mean. */
  frontmostApp?: string | null
  /** The most recent controller/tray/hotkey action, with a monotonic sequence number. */
  action?: { name: string; seq: number } | null
}

export interface SystemState {
  frontmostApp: string | null
  displays: DisplayInfo[]
  awake: boolean
}

export interface DisplayInfo {
  id?: number
  /** The display's complete source id, minted natively (never built in JavaScript). */
  source_id?: string
  bounds: Rect
  workArea?: Rect
  scaleFactor?: number
}

export type TrayAction =
  | 'showControls'
  | 'openSettings'
  | 'toggleAutoOcr'
  | 'selectAndScan'
  | 'editCropArea'
  | 'openLog'
  | 'toggleTextOverlay'
  | 'toggleDebugOverlay'
  | 'quit'

/** The bindable actions; `HOTKEY_ACTIONS` in `src-tauri/src/actions.rs`. */
export type HotkeyName = 'triggerScan' | 'openControllerMenu'

/** Declared once in the shared schema module; re-exported here for convenience. */
export type { OcrMode } from '@ui/settings'

/**
 * `capture_pick_source`: the system picker's outcome. Picked means the shared source is already
 * selected (as choosing a grid tile would), so `source` is for display only.
 */
export type PickSourceResult =
  | {
      picked: true
      source: NativeSource
      selection: { sourceId: string; crop: NativeCrop | null; key: string }
    }
  | {
      picked: false
      /** `cancelled` also covers a picker that timed out or could not open. */
      reason: 'cancelled' | 'busy' | 'ambiguous'
      message: string
    }

/** Error prefixes defined in COMMANDS.md. `busy:` is always safe to retry. */
export type NativeErrorKind = 'busy' | 'permission' | 'gone' | 'invalid' | 'native' | 'unknown'

/** Declared once beside its macOS default (`ui/capabilities.ts`); re-exported for the panels. */
export type {
  CaptureAuthorization,
  OcrEngineCapability,
  OcrEngineKey,
  PlatformCapabilities,
  PlatformOs
} from '@ui/capabilities'
