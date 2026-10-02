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
  | 'yomitan'
  | 'tray-popover'
  | 'welcome'
  | 'overlay'
  | 'fixture'

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

export interface PanelInfo {
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
export interface ViewState {
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
  sourceFocus?: { focused: boolean; present: boolean; held: boolean }
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
  } | null
  crop?: NativeCrop | null
  cropEnabled?: boolean
  isScanning?: boolean
  autoOcrEnabled?: boolean
  overlayVisible?: boolean
  textOverlayVisible?: boolean
  debugOverlayVisible?: boolean
  permission?: 'granted' | 'denied' | 'unknown'
  /** Raw and unfiltered; consumers decide what Kimochi's own windows mean. */
  frontmostApp?: string | null
  /** Whether macOS Accessibility is granted (needed for key-triggered auto-scan). */
  accessibility?: boolean
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

export type HotkeyName =
  | 'triggerScan'
  | 'toggleOverlay'
  | 'setCropArea'
  | 'playAudio'
  | 'selectAndScan'

/** Declared once in the shared schema module; re-exported here for convenience. */
export type { OcrMode } from '@ui/settings'

/** Error prefixes defined in COMMANDS.md. `busy:` is always safe to retry. */
export type NativeErrorKind = 'busy' | 'permission' | 'gone' | 'invalid' | 'native' | 'unknown'
