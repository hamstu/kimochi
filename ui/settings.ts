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
export type OcrMode = 'googlelens' | 'cloud' | 'meikiocr' | 'mangaocr' | 'livetext' | 'oneocr'
/** Window appearance. `system` follows the OS light/dark setting. */
export type Appearance = 'system' | 'light' | 'dark'
/** Interface scale: type, spacing and controls move together. Transcript text has its own size. */
/**
 * How `yomitanSettings.popupType` is stored. `'builtin'` (Yomitan) and `'custom-api'` predate the
 * other engines and keep their spelling, so no stored setting needs migrating.
 */
export type PopupType = 'builtin' | 'custom-api' | 'hachidori' | 'tenten'

/** The dictionary engine by name, as everything but the stored setting speaks of it. */
export type DictionaryEngine = 'yomitan' | 'hachidori' | 'tenten' | 'custom-api'

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
    /** Which dictionary engine; see `DICTIONARY_ENGINES`. `'builtin'` is Yomitan. */
    popupType: PopupType
    customApiUrl: string
  }
  ocrMode: OcrMode
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
  autoScanSettings: { enabled: false, scanDelay: 500 },
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
  ocrMode: 'googlelens',
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
  googlelens: {
    label: 'Google Lens',
    name: 'Google Lens',
    tagline: 'Online, sent to Google',
    geometry: true,
    runs: 'online',
    description:
      'Sends each capture to Google Lens, the image recognition behind Lens in Chrome, and returns the text with the position of every line. Very accurate on Japanese, horizontal or vertical, with nothing to set up.',
    strengths: [
      'Accurate on game text, manga and busy backgrounds',
      'Reads vertical and horizontal text, with line positions for the overlay',
      'Nothing to download, and the same on every computer'
    ],
    requirements:
      "Needs an internet connection. Each capture is sent to Google and handled under Google's terms and privacy policy. Kimochi uses the service Chrome's Lens uses, which is not a published API, so Google could change or stop it at any time."
  },
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
  }
}

/**
 * What a dictionary engine is, for Settings → Dictionary's chooser, the dictionary panel and
 * onboarding. The chooser lists every key, in this order. See DICTIONARY_ENGINES.md §1.
 */
export interface DictionaryEngineInfo {
  name: string
  /** One short line under the name in the chooser's list. */
  tagline: string
  description: string
  strengths: string[]
  /** What it needs, and anything about how it runs inside Kimochi worth knowing up front. */
  requirements: string
  /** The engine's licence (an SPDX id), or where it comes from when it is Kimochi's own. */
  licence: string
  /** The project's home, linked from the chooser. */
  upstream: string
  /** The link's text when it is not the engine's own project ("Upstream" otherwise). */
  upstreamLabel?: string
  /** The bundled release, or null for Kimochi's own pop-up. */
  version: string | null
  runs: 'local' | 'online'
  /** The engine's own options page, relative to its origin; null when it has none. */
  optionsPage: string | null
  /** Shown as a badge beside the name. */
  experimental?: boolean
}

export const DICTIONARY_ENGINES: Record<DictionaryEngine, DictionaryEngineInfo> = {
  yomitan: {
    name: 'Yomitan',
    tagline: 'The popup dictionary you may already use',
    description:
      'Yomitan itself, running inside Kimochi. Import the Yomitan dictionaries you already have; audio, scanning options and Anki mining are all set up in its own settings.',
    strengths: [
      'Imports any Yomitan dictionary, including settings backups',
      'Word audio and Anki mining built in',
      'Works offline once dictionaries are imported'
    ],
    requirements:
      'Downloaded from its official release when you choose it (about 15 MB). Needs at least one dictionary: the setup offers Jitendex, or import your own in Yomitan settings.',
    licence: 'GPL-3.0-or-later',
    upstream: 'https://github.com/yomidevs/yomitan',
    version: '26.8.24.0',
    runs: 'local',
    optionsPage: 'settings.html'
  },
  hachidori: {
    name: 'Hachidori',
    tagline: 'Fast, with native dictionary indexes',
    description:
      'A fast lookup engine written in C++ and compiled to WebAssembly, which keeps dictionaries in native indexes rather than a browser database. It imports Yomitan dictionaries and MDict, and on first run offers a set of recommended dictionaries.',
    strengths: [
      'Quick lookups, even with many large dictionaries',
      'Imports Yomitan dictionaries and MDict',
      'Recommended dictionaries offered on first run',
      'Anki mining through AnkiConnect'
    ],
    requirements:
      'Downloaded from its official release when you choose it (about 5 MB). Needs dictionaries, from its first-run offer or your own. Kimochi runs its single-threaded engine, so imports take a few seconds longer than in Chrome.',
    licence: 'GPL-3.0-or-later',
    upstream: 'https://github.com/bee-san/hachidori',
    version: '0.3.0',
    runs: 'local',
    optionsPage: 'settings.html'
  },
  tenten: {
    name: '10ten',
    tagline: 'Lightweight, works straight away',
    description:
      '10ten Japanese Reader is a lightweight reader with a word dictionary bundled in, so it looks words up the moment it is chosen. It then downloads the full JMdict, kanji and names dictionaries in the background.',
    strengths: [
      'Works immediately, with nothing to import',
      'Kanji and proper-name lookups',
      'Small and quick to start'
    ],
    requirements:
      'Downloaded from its official release when you choose it (about 18 MB), then fetches its full dictionaries from data.10ten.life and keeps them up to date. No Anki mining.',
    licence: 'GPL-3.0-or-later',
    upstream: 'https://github.com/birchill/10ten-ja-reader',
    version: '1.28.0',
    runs: 'local',
    optionsPage: 'options.html'
  },
  'custom-api': {
    name: 'Kimochi pop-up',
    tagline: 'Over a Yomitan API server',
    description:
      'Click words in the Log to look them up through a Yomitan API server, and build Anki cards here.',
    strengths: [
      'Click-to-define and furigana in the Log',
      'Anki card builder in Kimochi',
      'Uses a Yomitan API server you run'
    ],
    requirements: 'Needs a Yomitan API server reachable from this computer, and Yomitan downloaded (it splits the text into words).',
    licence: 'Part of Kimochi',
    upstream: 'https://github.com/yomidevs/yomitan-api',
    upstreamLabel: 'Yomitan API',
    version: null,
    runs: 'online',
    optionsPage: null,
    experimental: true
  }
}

const ENGINE_OF: Record<PopupType, DictionaryEngine> = {
  builtin: 'yomitan',
  'custom-api': 'custom-api',
  hachidori: 'hachidori',
  tenten: 'tenten'
}

/** The engine a stored `popupType` names. Anything unrecognised is Yomitan, the default. */
export function dictionaryEngineOf(popupType: unknown): DictionaryEngine {
  return typeof popupType === 'string' && Object.hasOwn(ENGINE_OF, popupType)
    ? ENGINE_OF[popupType as PopupType]
    : 'yomitan'
}
/** The contract's name for `dictionaryEngineOf` (DICTIONARY_ENGINES.md §1). */
export const dictionaryEngine = dictionaryEngineOf

/** How an engine is stored in `yomitanSettings.popupType`. */
export function popupTypeOf(engine: DictionaryEngine): PopupType {
  return engine === 'yomitan' ? 'builtin' : engine
}

/**
 * The engine whose host scripts a window needs. Kimochi's pop-up runs over the Yomitan host: the
 * overlay keeps Yomitan's backend for the controller's word splitting (`parseText`) and installs
 * the API lookup hook from it (`ui/api-lookup.js`), exactly as before the other engines existed.
 * So switching between Yomitan and Kimochi's pop-up changes no host and needs no reload.
 */
export function hostEngineOf(engine: DictionaryEngine): 'yomitan' | 'hachidori' | 'tenten' {
  return engine === 'custom-api' ? 'yomitan' : engine
}

/**
 * The document-start mirror of the engine (`localStorage` on the app origin), which the injected
 * host scripts read synchronously before any extension script runs. See DICTIONARY_ENGINES.md §2.
 * It holds `hostEngineOf(engine)`, never `'custom-api'`, so the Yomitan shims keep installing for
 * Kimochi's pop-up.
 */
export const DICTIONARY_ENGINE_KEY = 'kimochi.dictionaryEngine'

/**
 * The engine as the injected scripts resolve it: the mirror, else the value native put in the
 * window prelude, else Yomitan. Either may hold a stored spelling (`'builtin'`) or an engine name.
 */
export function resolveDictionaryEngine(
  mirrored: string | null | undefined,
  injected: string | null | undefined
): DictionaryEngine {
  const value = mirrored ?? injected ?? 'yomitan'
  return value === 'yomitan' ? 'yomitan' : dictionaryEngineOf(value)
}

/**
 * The host a document installs: an engine, or `'none'` when the selected engine is not downloaded
 * (nothing is bundled, so there is no fallback). Native publishes it in the window prelude and the
 * overlay mirrors it (DICTIONARY_ENGINES.md §2); neither the Yomitan shims nor the generic host
 * install for `'none'`.
 */
export type HostEngine = 'yomitan' | 'hachidori' | 'tenten' | 'none'
export const NO_ENGINE = 'none' as const

/** What lookups say while no engine is downloaded. */
export const NO_ENGINE_MESSAGE =
  'No dictionary is set up yet. Choose and download one in Settings → Dictionary.'

/** `resolveDictionaryEngine`, keeping `'none'` instead of reading it as Yomitan. */
export function resolveHostEngine(mirrored: string | null | undefined, injected: string | null | undefined): HostEngine {
  const value = mirrored ?? injected
  if (value === NO_ENGINE) return NO_ENGINE
  return hostEngineOf(resolveDictionaryEngine(value, null))
}

/**
 * Where the main window was when it switched dictionary engines, kept in its `sessionStorage`
 * across the reload `dictionary_engine_apply` gives it (DICTIONARY_ENGINES.md §2). Per window,
 * survives a reload, never a relaunch. The reloaded window opens straight onto this page (no Log
 * first) and Settings → Dictionary says which engine is now in use.
 */
export const ENGINE_SWITCH_KEY = 'kimochi.engineSwitch'
/**
 * A record older than this is not this reload's: a switch whose reload never came (the command
 * failed, the window was closed) must not reopen Settings on some later, unrelated reload.
 */
export const ENGINE_SWITCH_TTL_MS = 30_000

export interface EngineSwitchRecord {
  /** The engine just chosen, for "Now using …". */
  engine: DictionaryEngine
  /** The main window's view; a switch is made from Settings. */
  view: 'settings'
  /** The Settings page (`settingsActiveTab`), so the first frame is that page, not the default. */
  tab: string
  /** Where Back from Settings returns to. */
  back: 'log' | 'notebook'
  /** The Settings page's scroll offset, in CSS pixels. */
  scrollTop: number
  /** `Date.now()` when the switch was made. */
  at: number
}

export function encodeEngineSwitch(record: EngineSwitchRecord): string {
  return JSON.stringify(record)
}

/** The record if `raw` is a well-formed one from the last `ENGINE_SWITCH_TTL_MS`, else null. */
export function decodeEngineSwitch(raw: string | null | undefined, now: number): EngineSwitchRecord | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const { engine, view, tab, back, scrollTop, at } = record
  if (typeof engine !== 'string' || !Object.hasOwn(DICTIONARY_ENGINES, engine)) return null
  if (view !== 'settings' || typeof tab !== 'string' || !tab) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  // A clock that stepped back a little still counts; a record from the future does not.
  if (now - at > ENGINE_SWITCH_TTL_MS || at - now > 5_000) return null
  return {
    engine: engine as DictionaryEngine,
    view,
    tab,
    back: back === 'notebook' ? 'notebook' : 'log',
    scrollTop: typeof scrollTop === 'number' && Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0,
    at
  }
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
  // OwOCR (the WebSocket OCR mode) was removed: a stored choice falls back to the default engine.
  if (key === 'ocrMode' && stored === 'websocket') return SETTINGS_DEFAULTS.ocrMode as Settings[K]
  // Automatic OCR is the one key whose stored shape changed meaning rather than
  // only gaining fields, so it gets a real migration instead of a shallow merge.
  if (key === 'autoOCRSettings') return migrateAutoScanSettings(stored) as Settings[K]
  if (key === 'yomitanSettings') {
    // A popupType written by a newer build (an engine this one does not ship) reads as Yomitan
    // rather than leaving every window guessing.
    const merged =
      stored && typeof stored === 'object' && !Array.isArray(stored)
        ? { ...SETTINGS_DEFAULTS.yomitanSettings, ...(stored as object) }
        : SETTINGS_DEFAULTS.yomitanSettings
    return {
      ...merged,
      popupType: popupTypeOf(dictionaryEngineOf(merged.popupType))
    } as Settings[K]
  }
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
