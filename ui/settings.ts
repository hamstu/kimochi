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
/** Cloud OCR is the only backend that returns geometry; see OCR_MODES below. */
export type OcrMode = 'cloud' | 'local' | 'websocket'

export interface ScanHistoryEntry {
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
  yomitanSettings: { popupType: 'builtin' | 'custom-api'; customApiUrl: string }
  ocrMode: OcrMode
  owocrWebSocketUrl: string
  scannedTextHistory: ScanHistoryEntry[]
  scannedTextFontSize: number
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
  yomitanSettings: { popupType: 'builtin', customApiUrl: '' },
  ocrMode: 'cloud',
  owocrWebSocketUrl: 'ws://localhost:7331',
  scannedTextHistory: [],
  scannedTextFontSize: 14
}

/**
 * What each OCR backend can actually do. Only the cloud endpoint returns
 * bounding boxes, so the other two feed history, the texthooker and TTS but
 * cannot position overlay text. Surfacing this rather than hiding it is the
 * point: a mode that silently renders nothing would look broken.
 */
export const OCR_MODES: Record<OcrMode, { label: string; geometry: boolean; detail: string }> = {
  cloud: {
    label: 'Cloud OCR',
    geometry: true,
    detail: 'Returns word positions, so scanned text can be selected and looked up in place.'
  },
  local: {
    label: 'Local (Tesseract)',
    geometry: false,
    detail: 'Runs on this machine. Returns text only — no selectable overlay boxes.'
  },
  websocket: {
    label: 'WebSocket (OwOCR)',
    geometry: false,
    detail: 'Sends the capture to a local OwOCR server. Returns text only — no overlay boxes.'
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
