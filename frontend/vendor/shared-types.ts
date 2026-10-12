/**
 * VERBATIM COPY of `src/shared/types.ts` from the Electron app (do not hand-edit).
 * Kept byte-identical apart from this header and relative import paths, except one delta:
 * hotkeys gained gamepad chords (`gamepadButtons`) to stay in step with the native settings.
 */
export interface NativeScreen {
  id: number
  name: string
  width: number
  height: number
}

export interface NativeWindow {
  id: number
  title: string
  appName: string
  x: number
  y: number
  width: number
  height: number
  currentMonitor: {
    id: number
    name: string
  }
}

export interface CaptureSource {
  id: number
  name: string
  sourceId: string
  thumbnail: string
  type: 'screen' | 'window'
  icon?: string
  appName?: string
}

export type WindowPosition = {
  x: number
  y: number
  width: number
  height: number
}

export type CropRegion = {
  x: number // pixel coordinates
  y: number // pixel coordinates
  width: number // pixel width
  height: number // pixel height
  videoWidth: number // original video width in pixels
  videoHeight: number // original video height in pixels
}

export type CropRegionSettings = {
  [appName: string]: CropRegion
}

export type CropScanSettings = {
  [appName: string]: boolean
}

export type HotkeyDefinition = {
  name?: string
  accelerator: string
  enabled?: boolean
  description?: string
  /** Gamepad chord: W3C standard button indices (0-16) that must all be held. */
  gamepadButtons?: number[]
  /** Legacy single button, read as a chord of one; superseded by `gamepadButtons`. */
  gamepadButton?: number
}

export type HotkeysSettings = {
  [hotkeyName: string]: HotkeyDefinition
}

// Only store custom accelerator overrides and enabled state in settings
export type HotkeyOverrides = {
  [hotkeyName: string]: {
    accelerator?: string
    enabled?: boolean
    gamepadButtons?: number[] | null
    gamepadButton?: number
  }
}

/**
 * `yomitanSettings.popupType`. `'builtin'` is Yomitan; the engine table and the
 * `dictionaryEngineOf` / `popupTypeOf` helpers live in `ui/settings.ts` (`@ui/settings`).
 */
export type PopupType = 'builtin' | 'custom-api' | 'hachidori' | 'tenten'

/** The dictionary engine by name; see `DICTIONARY_ENGINES` in `ui/settings.ts`. */
export type DictionaryEngine = 'yomitan' | 'hachidori' | 'tenten' | 'custom-api'

export type YomitanSettings = {
  popupType: PopupType
  customApiUrl: string
}

export type TokenPart = {
  reading: string
  text: string
}

export type TokenizedTerm = TokenPart[]

export type TokenizeResponse = {
  content: TokenizedTerm[]
  dictionary: string | null
  id: string
  source: string
}[]

export type AudioSettings = {
  voiceId: string
}

// Google Vision API types
export type Vertex = {
  x: number
  y: number
}

export type BoundingPoly = {
  vertices: Vertex[]
}

export type TextAnnotation = {
  locale?: string
  description: string
  boundingPoly: BoundingPoly
}

export type GoogleVisionOCRResult = {
  fullText: string
  textAnnotations: TextAnnotation[]
  // Full capture dimensions before cropping, used to scale OCR coordinates.
  videoWidth?: number
  videoHeight?: number
}

// Live overlay settings
export type LiveOverlaySettings = {
  enabled: boolean
}

// Auto-scan after button press settings
export type AutoScanSettings = {
  enabled: boolean
  triggerKeys: string // comma-separated list of keys
  scanDelay: number // delay in milliseconds
  gamepadButton?: number // optional gamepad button index to trigger scan
}

// Text overlay grouping settings
export type TextOverlayGroupingSettings = {
  enabled: boolean
  proximityThreshold: number // pixels - how close text boxes need to be to group
  filterSmallText: boolean // filter out furigana and small text (default: true)
  filterSmallTextThreshold: number // threshold as ratio of median height (default: 0.75)
}

// Window focus event from watcher
export type WindowFocusEvent = {
  type: 'windowFocus'
  windowTitle: string
  appName: string
  appPath: string
}

// Server settings (OCR/TTS server)
export type ServerSettings = {
  mode: 'cloud' | 'local'
}

// Scan history entry
export type ScanHistoryEntry = {
  id: string
  text: string
  timestamp: number
}

// Last selected source for persistence across app restarts
export type LastSelectedSource = {
  sourceId: string // The Electron desktopCapturer ID (may change across restarts)
  type: 'screen' | 'window'
  name: string // Display name or window title
  appName?: string // For windows, the app name
}

// Gamepad device info (from Web Gamepad API)
export type GamepadDevice = {
  index: number // Gamepad index in navigator.getGamepads()
  id: string // Gamepad identifier string
  connected: boolean
  mapping: string // "standard" or ""
  buttons: number // Number of buttons
  axes: number // Number of axes
  timestamp: number // Last update timestamp
}

// Gamepad settings
export type GamepadSettings = {
  enabled: boolean
  preferredGamepadIndex?: number // Index of preferred gamepad
}

// Gamepad state for UI updates
export type GamepadState = {
  gamepads: GamepadDevice[]
  activeGamepadIndex: number | null
  buttonStates: boolean[] // Current button pressed states for active gamepad
  axisStates: number[] // Current axis values for active gamepad
}

// Auto-OCR settings: local observation, settling, and request budgeting.
//
// Mirrors `AutoScanSettings` in ui/autoscan.ts, which is the definition that the
// scheduler actually reads and migrates. Keep the two in step.
export type AutoOCRSettings = {
  version: number // Migration version for observation cadence defaults
  pollInterval: number // Base poll interval in ms (default: 500)
  // Which local signal settles a candidate. 'text' reads the words with the
  // platform's local observer and is the default; 'image' compares a perceptual
  // hash instead and is only ever chosen deliberately, because it cannot tell a
  // moving background from new dialogue.
  observerMode: 'text' | 'image'
  stableObservations: number // Identical readings before recognising (default: 2, minimum 2)
  maxCandidateAgeMs: number // Longest wait for text that keeps moving (default: 4000)
  minRequestSpacingMs: number // Floor between two accurate recognitions (default: 1200)
  emptyObservationsToClear: number // Blank readings before a repeat may return (default: 3)
  boxTolerancePx: number // Slack when two readings are called the same layout (default: 3)
  errorBackoffMs: number // First error backoff; doubles per failure (default: 2000)
  maxErrorBackoffMs: number // Cap on that backoff (default: 30000)
  maxConsecutiveErrors: number // Failures before automatic scanning suspends (default: 5)
  imageHashThreshold: number // Hamming distance threshold, used by 'image' mode (default: 5)
  // Retained so a settings file written by an older build round-trips. Neither
  // selects the local gate any longer — `observerMode` does — because a stored
  // `localOCRGateEnabled: false`, which is what every existing install has, used
  // to mean "no gate at all" and so meant every frame reached the endpoint.
  localOCRSimilarityThreshold: number
  localOCRGateEnabled: boolean
  adaptivePollingEnabled: boolean // Whether to use adaptive polling intervals (default: true)
  adaptivePollMin: number // Minimum adaptive poll interval in ms (default: 250)
  adaptivePollMax: number // Maximum adaptive poll interval in ms (default: 500)
}

// Display info for multi-monitor support
export type DisplayBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type DisplayInfo = {
  id: number
  bounds: DisplayBounds
  workArea: DisplayBounds
  scaleFactor: number
  // The overlay window's position in screen coordinates
  // Used to convert screen coords to overlay-relative coords
  // Only present when querying the current overlay display, not when listing all displays
  overlayOffset?: { x: number; y: number }
}

// Texthooker settings for outputting OCR text to clipboard/WebSocket
export type TexthookerSettings = {
  copyToClipboard: boolean
  sendToWebSocket: boolean
  webSocketUrl: string
}
