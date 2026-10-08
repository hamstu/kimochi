import type { OcrGroup } from './ocr-result.js'
/**
 * The settings schema, shared by the overlay and the React panels.
 *
 * Keys and defaults are those of the Electron app's electron-store schema
 * (src/main/settings.ts, plus the keys that are only ever written through
 * useSetting: overlayOpacity, liveOverlayEnabled, textOverlayGrouping,
 * serverSettings, yomitanSettings). Defaults live here, in one place, so the
 * overlay and the panels cannot drift apart — import this rather than
 * re-declaring a default anywhere else.
 *
 * Transport is deliberately not in this file: native owns the store, and each
 * window reaches it through its own client.
 */

import {
  DEFAULT_AUTO_OCR_SETTINGS,
  migrateAutoScanSettings,
  type AutoScanSettings
} from './autoscan.js'
import { DEFAULT_GROUPING, type GroupingSettings } from './annotations.js'

export type ServerMode = 'cloud' | 'local'
/** Backends available to both manual and automatic scanning. */
export type OcrMode = 'cloud' | 'websocket' | 'meikiocr' | 'mangaocr' | 'livetext' | 'oneocr'
/** Window appearance. `system` follows the OS light/dark setting. */
export type Appearance = 'system' | 'light' | 'dark'
/** Interface scale: type, spacing and controls move together. Transcript text has its own size. */
export type InterfaceScale = 'small' | 'medium' | 'large' | 'xlarge'
export const INTERFACE_SCALES: Record<InterfaceScale, { label: string; factor: number }> = {
  small: { label: 'Small', factor: 0.92 },
  medium: { label: 'Medium', factor: 1 },
  large: { label: 'Large', factor: 1.1 },
  xlarge: { label: 'Extra large', factor: 1.22 }
}

/**
 * The buttons of the overlay's controller menu and word mode, as standard (W3C) button indices;
 * `null` leaves an action unbound. The D-pad and sticks are fixed: they are how the menu and the
 * word cursor are steered, not commands.
 */
export interface ControllerButtons {
  /** Choose the menu item; in word mode, look the word up again. */
  confirm: number | null
  /** Close the menu, or leave word mode and return to the game. */
  back: number | null
  backAlt: number | null
  /** Jump to the previous or next definition in the dictionary popup. */
  previousDefinition: number | null
  nextDefinition: number | null
}

export const DEFAULT_CONTROLLER_BUTTONS: ControllerButtons = {
  confirm: 0,
  back: 1,
  backAlt: 3,
  previousDefinition: 4,
  nextDefinition: 5
}

export interface ScanHistoryEntry {
  groups?: OcrGroup[]
  engine?: string
  id: string
  text: string
  timestamp: number
}

export interface Settings {
  overlayOpacity: number
  liveOverlayEnabled: boolean
  textOverlayGrouping: GroupingSettings
  autoOCRSettings: AutoScanSettings
  autoScanSettings: {
    enabled: boolean
    triggerKeys: string
    scanDelay: number
    gamepadButton?: number
  }
  texthookerSettings: {
    copyToClipboard: boolean
    sendToWebSocket: boolean
    webSocketUrl: string
  }
  audioSettings: { voiceId: string }
  serverSettings: { mode: ServerMode }
  gamepadSettings: { enabled: boolean; preferredGamepadIndex?: number }
  controllerButtons: ControllerButtons
  yomitanSettings: {
    popupType: 'builtin' | 'custom-api'
    customApiUrl: string
  }
  ocrMode: OcrMode
  owocrWebSocketUrl: string
  scannedTextHistory: ScanHistoryEntry[]
  scannedTextFontSize: number
  appearance: Appearance
  interfaceScale: InterfaceScale
  /** Sounds when a scan starts, adds lines or fails; see sounds.ts. */
  soundEffects: boolean
}

export const DEFAULT_VOICE_ID = 'j210dv0vWm7fCknyQpbA'
export const SERVER_URLS: Record<ServerMode, string> = {
  local: 'http://localhost:3000',
  cloud: 'https://kimochi-server.hamish.workers.dev'
}
export const MAX_HISTORY_ENTRIES = 50

export const SETTINGS_DEFAULTS: Settings = {
  overlayOpacity: 80,
  liveOverlayEnabled: false,
  textOverlayGrouping: DEFAULT_GROUPING,
  autoOCRSettings: DEFAULT_AUTO_OCR_SETTINGS,
  autoScanSettings: { enabled: false, triggerKeys: '', scanDelay: 500 },
  texthookerSettings: {
    copyToClipboard: false,
    sendToWebSocket: false,
    webSocketUrl: 'ws://localhost:6677'
  },
  audioSettings: { voiceId: DEFAULT_VOICE_ID },
  serverSettings: { mode: 'cloud' },
  gamepadSettings: { enabled: true, preferredGamepadIndex: undefined },
  controllerButtons: DEFAULT_CONTROLLER_BUTTONS,
  yomitanSettings: { popupType: 'builtin', customApiUrl: '' },
  ocrMode: 'cloud',
  owocrWebSocketUrl: 'ws://localhost:7331',
  scannedTextHistory: [],
  scannedTextFontSize: 14,
  appearance: 'system',
  interfaceScale: 'medium',
  soundEffects: true
}

/**
 * What an OCR engine is, for Settings → OCR & Overlay's engine chooser, the sidebar picker and the
 * overlay. Adding an engine is adding an entry here (and its capability in `ui/capabilities.ts`):
 * the chooser lists every key, in this order, and draws the rest from these fields.
 */
export interface OcrModeInfo {
  /** The picker label, which says where it runs ("Local (MeikiOCR)"). */
  label: string
  /** The engine's own name, as the chooser's list and detail heading show it. */
  name: string
  /** One short line under the name in the chooser's list. */
  tagline: string
  /** Whether results carry positions, so the overlay can draw over the game. */
  geometry: boolean
  /** Where it runs: on this computer, or a service across the network (the chooser's icon). */
  runs: 'local' | 'online'
  /** What it is and what it is good for: the chooser's detail paragraph. */
  description: string
  /** Two to four short reasons to pick it. */
  strengths: string[]
  /** What it needs to run: a connection, a download, a server of your own. */
  requirements: string
}

/** Capabilities and descriptions shared by Settings and the overlay. */
export const OCR_MODES: Record<OcrMode, OcrModeInfo> = {
  cloud: {
    label: 'Cloud OCR',
    name: 'Cloud OCR',
    tagline: 'Online, via Google Vision',
    geometry: true,
    runs: 'online',
    description:
      'Sends each capture to the Kimochi server, which reads it with Google Cloud Vision and returns the text with the position of every word. Dependable on almost any Japanese text, at the cost of a round trip over the network.',
    strengths: [
      'Accurate across fonts, sizes and busy backgrounds',
      'Word positions, so text can be hovered and looked up in place',
      'Nothing to download, and the same on every computer'
    ],
    requirements:
      'Needs an internet connection. Each capture is sent to the Kimochi server to be read.'
  },
  meikiocr: {
    label: 'Local (MeikiOCR)',
    name: 'MeikiOCR',
    tagline: 'Offline, for game text',
    geometry: true,
    runs: 'local',
    description:
      'A small, fast recogniser that runs entirely on this computer. It is tuned for Japanese video game text: dialogue boxes, menus and subtitles, horizontal or vertical, with a box for every line.',
    strengths: [
      'Fast: a scan takes a fraction of a second',
      'Works offline; captures never leave this computer',
      'Line positions, so the overlay can draw over your game'
    ],
    requirements:
      'A one-time model download. Uses the GPU where it can (Core ML on macOS, DirectML on Windows) and the CPU otherwise.'
  },
  mangaocr: {
    label: 'Local (Manga OCR)',
    name: 'Manga OCR',
    tagline: 'Offline, for manga',
    geometry: true,
    runs: 'local',
    description:
      'Finds speech bubbles and text blocks with the comic text detector, then reads each one with Manga OCR, a model trained on manga. The best choice for comics, stylised lettering and vertical text.',
    strengths: [
      'Excellent on vertical text and hand-lettered dialogue',
      'Reads text set over busy artwork',
      'Works offline; captures never leave this computer'
    ],
    requirements:
      'A larger one-time model download, and each scan takes longer than with MeikiOCR. Uses the GPU where it can (Metal on macOS, CUDA on NVIDIA cards) and the CPU otherwise.'
  },
  livetext: {
    label: 'Local (Apple Live Text)',
    name: 'Apple Live Text',
    tagline: 'Offline, built into macOS',
    geometry: true,
    runs: 'local',
    description:
      'Reads text locally with the engine behind Live Text, the same recognition macOS uses when you select text in a screenshot. Returns line positions for dictionary lookups directly over the captured text.',
    strengths: [
      'Nothing to download: part of macOS',
      'Fast, with no model to load',
      'Works offline; captures never leave this computer',
      'Handles vertical and horizontal text'
    ],
    requirements:
      'macOS 13 or later. Uses the system Live Text engine through an unpublished interface, so a future macOS release could need an update.'
  },
  oneocr: {
    label: 'Local (OneOCR)',
    name: 'OneOCR',
    tagline: 'Offline, via Snipping Tool',
    geometry: true,
    runs: 'local',
    description:
      'Reads text locally using the OCR engine in Microsoft Snipping Tool. Returns word and line positions for dictionary lookups directly over the captured text.',
    strengths: [
      'Works offline; captures never leave this computer',
      'Word positions for overlay lookups',
      'Uses the Snipping Tool runtime already installed on Windows 11'
    ],
    requirements:
      'Windows only. On Windows 11, install or update Microsoft Snipping Tool. No Python or OCR server is needed.'
  },
  websocket: {
    label: 'WebSocket (OwOCR)',
    name: 'OwOCR',
    tagline: 'Your own OwOCR server',
    geometry: false,
    runs: 'local',
    description:
      'Sends each capture to an OwOCR server you run yourself, so any engine OwOCR supports can read your game.',
    strengths: ['Use any engine OwOCR supports', 'Runs wherever you host it'],
    requirements:
      'Needs OwOCR running and listening on a local WebSocket. It returns text only, so nothing is drawn over your game.'
  }
}

export function serverUrls(mode: ServerMode): { ocr: string; tts: string } {
  const base = SERVER_URLS[mode] ?? SERVER_URLS.cloud
  return { ocr: `${base}/detect-text`, tts: `${base}/tts` }
}

/**
 * Merge a stored value over its default.
 *
 * Objects are merged one level deep so a settings file written by an older
 * build — or by a panel that only knew about some of the fields — still yields
 * a complete value instead of undefined properties reaching the render path.
 */
export function withDefaults<K extends keyof Settings>(key: K, stored: unknown): Settings[K] {
  if (key === 'ocrMode' && stored === 'local') return 'meikiocr' as Settings[K]
  // Automatic OCR is the one key whose stored shape changed meaning rather than
  // only gaining fields, so it gets a real migration instead of a shallow merge.
  if (key === 'autoOCRSettings') return migrateAutoScanSettings(stored) as Settings[K]
  const fallback = SETTINGS_DEFAULTS[key]
  if (stored === undefined || stored === null) return fallback
  if (
    typeof fallback === 'object' &&
    fallback !== null &&
    !Array.isArray(fallback) &&
    typeof stored === 'object' &&
    !Array.isArray(stored)
  ) {
    return { ...(fallback as object), ...(stored as object) } as Settings[K]
  }
  return stored as Settings[K]
}

/**
 * Is OCR text actually going to be drawn?
 *
 * Two flags gate it. `liveOverlayEnabled` is the persisted preference for
 * drawing text over the source at all; `textOverlayVisible` is the session
 * show/hide. Both must be on, so this predicate — not either flag alone — is
 * what a control reflecting "is the overlay on" has to read. The renderer and
 * the remote control both call it, which is what keeps a toggle from showing one
 * state while the render gate holds another.
 */
export function isOverlayTextVisible(
  liveOverlayEnabled: boolean,
  textOverlayVisible: boolean
): boolean {
  return liveOverlayEnabled && textOverlayVisible
}

/**
 * What a single "overlay on/off" control should do next.
 *
 * Turning it on has to satisfy both gates, because the persisted one defaults to
 * off: without that, a fresh install shows a switch that flips a flag while the
 * text stays invisible, and the user has to discover a second switch in Settings
 * to make it mean anything. Turning it off touches only the session flag, so the
 * persisted preference the Settings panel shows is not silently rewritten every
 * time someone hides the text for a moment.
 */
export function nextOverlayToggle(current: {
  liveOverlayEnabled: boolean
  textOverlayVisible: boolean
}): { liveOverlayEnabled: boolean; textOverlayVisible: boolean } {
  return isOverlayTextVisible(current.liveOverlayEnabled, current.textOverlayVisible)
    ? { liveOverlayEnabled: current.liveOverlayEnabled, textOverlayVisible: false }
    : { liveOverlayEnabled: true, textOverlayVisible: true }
}

/** Newest first, capped, so the history cannot grow without bound. */
export function pushHistory(
  history: ScanHistoryEntry[],
  entry: ScanHistoryEntry
): ScanHistoryEntry[] {
  return [entry, ...history].slice(0, MAX_HISTORY_ENTRIES)
}

/** What switching the overlay's text on or off owes the reader. */
export type OverlayTextChange = 'idle' | 'scan' | 'scan-pending'

/**
 * Decide whether switching the overlay's text on should also scan.
 *
 * Two inputs decide whether text is drawn — a persisted preference and a session flag
 * — and they arrive on two channels, a settings change and a view broadcast. Both feed
 * this, and it compares the *combined* answer with the last one, so flipping one input
 * cannot look like two transitions and start two scans.
 *
 * Switching on scans, because otherwise it switches on to nothing: the overlay draws
 * the last scan, and if there was not one, or it belonged to a source that has since
 * changed, the reader gets an empty screen and has to ask for a scan by hand.
 *
 *  - `was === null` is startup. Nobody switched anything on, so nothing is owed.
 *  - switching *off* never scans.
 *  - a scan already running satisfies the transition: it will render into the overlay
 *    that was just switched on. `scan-pending` says so rather than silently doing
 *    nothing.
 */
export function overlayTextChange(
  was: boolean | null,
  shown: boolean,
  busy: boolean
): OverlayTextChange {
  if (was !== false || !shown) return 'idle'
  return busy ? 'scan-pending' : 'scan'
}
