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
export type OcrMode = 'googlelens' | 'cloud' | 'meikiocr' | 'mangaocr' | 'ppocr' | 'livetext' | 'oneocr'
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
 * word cursor are steered, not commands. Mirrors `DEFAULT_BUTTONS` in controller-input.js.
 */
export interface ControllerButtons {
  /** Choose the menu item; on a word, move into the dictionary pop-up; there, press its button. */
  confirm: number | null
  /** Close the menu, leave the pop-up for the text, or leave word mode for the game. */
  back: number | null
  /** Step by word or by character. */
  toggleUnit: number | null
  /** Play the word's audio from the pop-up. */
  playAudio: number | null
  /** Jump to the previous or next definition in the dictionary popup. */
  previousDefinition: number | null
  nextDefinition: number | null
  /** Show every control while reading. */
  showControls: number | null
}

export const DEFAULT_CONTROLLER_BUTTONS: ControllerButtons = {
  confirm: 0,
  back: 1,
  toggleUnit: 3,
  playAudio: 2,
  previousDefinition: 4,
  nextDefinition: 5,
  showControls: 8
}

/**
 * Stored controller buttons over the defaults: an action added since they were saved keeps its
 * default, and a retired one (`backAlt`, the second Back that Y used to be) is dropped.
 */
export function effectiveControllerButtons(
  stored: object | null | undefined
): ControllerButtons {
  const buttons = { ...DEFAULT_CONTROLLER_BUTTONS }
  for (const key of Object.keys(DEFAULT_CONTROLLER_BUTTONS) as (keyof ControllerButtons)[]) {
    const value = (stored as Record<string, unknown> | null | undefined)?.[key]
    if (value === null || typeof value === 'number') buttons[key] = value
  }
  return buttons
}

/** The other actions bound to the same button as `key`: both would fire on one press. */
export function sharedButtonActions(
  buttons: ControllerButtons,
  key: keyof ControllerButtons
): (keyof ControllerButtons)[] {
  const button = buttons[key]
  if (button === null) return []
  return (Object.keys(buttons) as (keyof ControllerButtons)[]).filter(
    (other) => other !== key && buttons[other] === button
  )
}

export interface ScanHistoryEntry {
  groups?: OcrGroup[]
  engine?: string
  id: string
  text: string
  timestamp: number
}

/**
 * How Read along shows the dictionary (Settings → Game Mode): `popup`, an outline on the game's
 * text and the dictionary's own pop-up beside it; `fullscreen`, the scan across the top of a
 * dimmed screen and the lit word's dictionary below it (ui/game-dictionary.js). Every engine can
 * be full screen: the Yomitan API's entries are drawn by Kimochi, and every other engine's own
 * pop-up (built-in Yomitan, Hachidori, 10ten) is placed to fill the space below the text.
 */
export type GameDictionaryView = 'popup' | 'fullscreen'

export interface GameModeSettings {
  dictionaryView: GameDictionaryView
}

export const DEFAULT_GAME_MODE_SETTINGS: GameModeSettings = { dictionaryView: 'popup' }

/**
 * Whether Read along opens the full-screen dictionary: Settings → Game Mode says so, whichever
 * engine is in use (it once also needed the Yomitan API; a caller still passing the engine as a
 * second argument from plain JS is unaffected).
 */
export function fullscreenDictionary(gameMode: unknown): boolean {
  return (gameMode as Partial<GameModeSettings> | null)?.dictionaryView === 'fullscreen'
}

/**
 * What fills the full-screen dictionary's lower half: `entries`, Kimochi's own drawing of the
 * Yomitan API's entries; `popup`, the engine's own pop-up (built-in Yomitan, Hachidori, 10ten),
 * placed over that space.
 */
export function fullscreenDictionarySource(popupType: unknown): 'entries' | 'popup' {
  return popupType === 'custom-api' ? 'entries' : 'popup'
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
  audioSettings: { voiceId: string; model?: string }
  serverSettings: { mode: ServerMode }
  gamepadSettings: { enabled: boolean; preferredGamepadIndex?: number }
  controllerButtons: ControllerButtons
  gameModeSettings: GameModeSettings
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
  /** Every sound effect; see sounds.ts. */
  soundEffects: boolean
  /** Under `soundEffects`: sounds when a scan starts, adds lines or fails. */
  soundEffectsScans: boolean
  /** Under `soundEffects`: the click of buttons, switches and menus, and the sidebar's whoosh. */
  soundEffectsClicks: boolean
  /** Under `soundEffects`: the volume of every sound effect, 0–1. */
  soundEffectsVolume: number
  /** Recording system audio for the cards' sentence audio (src-tauri/src/sentence_audio). This
      computer's: never synced. */
  sentenceAudio: SentenceAudioSettings
  /** Card enhancement's tags, on every new card whichever dictionary made it
      (src-tauri/src/card_tags.rs). */
  cardTags: CardTagsSettings
  /** Card enhancement's screenshot: each scan's source, kept for the Log and new cards
      (src-tauri/src/screenshots.rs). */
  cardScreenshot: CardScreenshotSettings
  /** The screenshot viewer draws what OCR read (the boxes, and the crop area faded around). */
  screenshotAnnotations: boolean
}

export interface CardScreenshotSettings {
  /** Give new cards the screenshot of the scan their sentence was read in. */
  enabled: boolean
  /** The note field the picture goes in. */
  field: string
  /** Screenshots kept on disk, 10 to 500. */
  kept: number
}

export interface CardTagsSettings {
  enabled: boolean
  /** Comma-separated; `{{session-name}}` is the open session's name. */
  tags: string
}

export interface SentenceAudioSettings {
  /** Keep the last `seconds` of what the computer plays, give each Log line the clip of its
      voice, and new cards their line's audio. */
  enabled: boolean
  /** 10 to 120. */
  seconds: number
  /** The note field the audio goes in (a field mapped to (sentence audio) wins for the
      Yomitan API pop-up). */
  field: string
  /** The note field the mined word's own audio goes in; empty: none. (A field mapped to (word
      audio) wins for the Yomitan API pop-up.) */
  wordField: string
  /** Line clips kept on disk, 5 to 100. */
  clips: number
  /** Move the clip's start and end, in milliseconds (negative: earlier). */
  startOffsetMs: number
  endOffsetMs: number
  /** Cut a clip placed by timing down to the voice in it. */
  trim: boolean
}

export const DEFAULT_VOICE_ID = 'j210dv0vWm7fCknyQpbA'
export const SERVER_URLS: Record<ServerMode, string> = {
  local: 'http://localhost:3000',
  cloud: 'https://kimochiapp.com'
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
  gameModeSettings: DEFAULT_GAME_MODE_SETTINGS,
  yomitanSettings: { popupType: 'builtin', customApiUrl: '' },
  ocrMode: 'googlelens',
  scannedTextHistory: [],
  scannedTextFontSize: 14,
  appearance: 'system',
  interfaceScale: 'medium',
  soundEffects: true,
  soundEffectsScans: true,
  soundEffectsClicks: true,
  soundEffectsVolume: 0.5,
  sentenceAudio: {
    enabled: false,
    seconds: 30,
    field: 'SentenceAudio',
    wordField: '',
    clips: 15,
    startOffsetMs: 0,
    endOffsetMs: 0,
    trim: true
  },
  cardTags: { enabled: true, tags: 'kimochi, {{session-name}}' },
  cardScreenshot: { enabled: true, field: 'Picture', kept: 50 },
  screenshotAnnotations: true
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
  /** What it needs to run, when there is something to say: an OS version, a server of your own. */
  requirements?: string
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
      'Sends each capture to Google Lens. The most accurate choice for most people, on games and manga alike, if you are happy for captures to go to Google. Free: no account and no API key.',
    strengths: [
      'Accurate on game text, manga and busy backgrounds',
      'Reads vertical and horizontal text, with line positions for the overlay',
      'Nothing to download, and the same on every computer'
    ],
    requirements: 'Needs an internet connection. No account or API key.'
  },
  cloud: {
    label: 'Cloud OCR',
    name: 'Cloud OCR',
    tagline: 'Online, via Google Vision',
    geometry: true,
    runs: 'online',
    description:
      'Sends each capture to the Kimochi server, which reads it with Google Cloud Vision and returns the text with the position of every word. Dependable on almost any Japanese text, at the cost of a round trip over the network. Part of Kimochi Cloud, so it needs a Kimochi account, not an API key of your own.',
    strengths: [
      'Accurate across fonts, sizes and busy backgrounds',
      'Word positions, so text can be hovered and looked up in place',
      'Nothing to download, and the same on every computer'
    ],
    requirements:
      'Needs an internet connection and a Kimochi account with Kimochi Cloud (a free trial is available in Settings → Account). Each capture is sent to the Kimochi server to be read.'
  },
  meikiocr: {
    label: 'Local (MeikiOCR)',
    name: 'MeikiOCR',
    tagline: 'Offline, for game text',
    geometry: true,
    runs: 'local',
    description:
      "A small, fast OCR model that runs on your computer. It's tuned for Japanese video game text: dialogue boxes, menus and subtitles, horizontal or vertical. The best offline pick for games; for manga, choose Manga OCR.",
    strengths: [
      'Fast: a scan takes a fraction of a second',
      'Works offline; captures never leave this computer',
      'A one-time model download, then nothing else to set up'
    ]
  },
  mangaocr: {
    label: 'Local (Manga OCR)',
    name: 'Manga OCR',
    tagline: 'Offline, for manga',
    geometry: true,
    runs: 'local',
    description:
      'A model trained specifically on manga. The best offline choice for manga and printed vertical text; slower than MeikiOCR on game dialogue.',
    strengths: [
      'Excellent on vertical text and hand-lettered dialogue',
      'Reads text set over busy artwork',
      'Works offline; captures never leave this computer'
    ],
    requirements:
      'This model uses the GPU where it can (Metal on macOS, DirectML on Windows) and the CPU otherwise.'
  },
  ppocr: {
    label: 'Local (PP-OCRv6)',
    name: 'PP-OCRv6',
    tagline: 'Offline, fast and accurate',
    geometry: true,
    runs: 'local',
    description:
      "PaddleOCR's PP-OCRv6 recognizer, running on your computer. Reads game dialogue, menus and vertical text accurately, keeps full-width characters as they appear on screen, and is quick on a graphics card.",
    strengths: [
      'Fast on a graphics card (DirectML on Windows)',
      'Accurate on horizontal and vertical text',
      'Works offline; captures never leave this computer'
    ],
    requirements:
      'A one-time model download of about 30 MB. Uses the GPU where it can and the CPU otherwise.'
  },
  livetext: {
    label: 'Local (Apple Live Text)',
    name: 'Apple Live Text',
    tagline: 'Offline, built into macOS',
    geometry: true,
    runs: 'local',
    description:
      "Uses macOS's Live Text, the same recognition macOS uses when you select text in a screenshot. A good all-round offline choice on a Mac, with nothing to download.",
    strengths: [
      'Nothing to download: part of macOS',
      'Fast, with no model to load',
      'Works offline; captures never leave this computer',
      'Handles vertical and horizontal text'
    ],
    requirements:
      'Requires macOS 13 or later.'
  },
  oneocr: {
    label: 'Local (OneOCR)',
    name: 'OneOCR',
    tagline: 'Offline, via Snipping Tool',
    geometry: true,
    runs: 'local',
    description:
      'Reads text on your computer with the OCR engine in Microsoft Snipping Tool. A good all-round offline choice on Windows, with nothing extra to download; on stylised game fonts MeikiOCR can do better, and on manga Manga OCR.',
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
  /** The bundled release, or null for the Yomitan API (Kimochi's own pop-up). */
  version: string | null
  runs: 'local' | 'online'
  /** The engine's own options page, relative to its origin; null when it has none. */
  optionsPage: string | null
}

export const DICTIONARY_ENGINES: Record<DictionaryEngine, DictionaryEngineInfo> = {
  yomitan: {
    // Not "Built-in": it is downloaded when chosen, and "Built-in" beside "Not downloaded" read as
    // a contradiction. The Yomitan API is the browser's Yomitan, so the two stay distinct.
    name: 'Yomitan',
    tagline: 'Runs inside Kimochi',
    description:
      'Yomitan running inside Kimochi, with its own dictionaries and settings (separate from any Yomitan in your browser). Word audio and Anki mining are built in.',
    strengths: [
      'Imports any Yomitan dictionary or settings backup',
      'Word audio and Anki mining',
      'Works offline'
    ],
    requirements:
      'Downloaded when you choose it (about 15 MB). Needs at least one dictionary.',
    licence: 'GPL-3.0-or-later',
    upstream: 'https://github.com/yomidevs/yomitan',
    version: '26.10.22.0',
    runs: 'local',
    optionsPage: 'settings.html'
  },
  hachidori: {
    name: 'Hachidori',
    tagline: 'Fast, with native dictionary indexes',
    description:
      'A fast engine that keeps dictionaries in native indexes. Imports Yomitan dictionaries and MDict.',
    strengths: [
      'Quick, even with many large dictionaries',
      'Recommended dictionaries on first run',
      'Anki mining through AnkiConnect'
    ],
    requirements:
      'Downloaded when you choose it (about 5 MB). Needs at least one dictionary.',
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
      '10ten Japanese Reader: a lightweight reader that looks words up the moment it is chosen.',
    strengths: [
      'Nothing to import',
      'Kanji and name lookups',
      'Small and quick to start'
    ],
    requirements:
      'Downloaded when you choose it (about 18 MB), then fetches its full dictionaries in the background. No Anki mining.',
    licence: 'GPL-3.0-or-later',
    upstream: 'https://github.com/birchill/10ten-ja-reader',
    version: '1.28.0',
    runs: 'local',
    optionsPage: 'options.html'
  },
  'custom-api': {
    name: 'Yomitan API',
    tagline: 'The Yomitan in your browser',
    description:
      'Looks words up through the Yomitan in your browser, using its dictionaries and settings as they are.',
    strengths: [
      'Nothing to import again',
      'Shift-hover lookups in the Log and over your source',
      'Anki card builder in Kimochi'
    ],
    requirements:
      'Needs Yomitan in your browser with its API on, and a small helper Kimochi installs for you.',
    licence: 'Part of Kimochi',
    upstream: 'https://github.com/yomidevs/yomitan-api',
    upstreamLabel: 'Yomitan API',
    version: null,
    // The browser's Yomitan on this computer (an address on another computer still works).
    runs: 'local',
    optionsPage: null
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
 * The engine whose host scripts a window needs. The Yomitan API engine (Kimochi's own pop-up over
 * the browser's Yomitan) needs none: it splits words and looks them up through the browser's
 * Yomitan over its API, and the overlay installs its lookup hook without any extension
 * (`startApiEngine` in ui/overlay.js). So it downloads nothing, and switching to or from it
 * reloads the reader windows as any other switch does.
 */
export function hostEngineOf(engine: DictionaryEngine): HostEngine {
  return engine === 'custom-api' ? NO_ENGINE : engine
}

/**
 * The document-start mirror of the engine (`localStorage` on the app origin), which the injected
 * host scripts read synchronously before any extension script runs. See DICTIONARY_ENGINES.md §2.
 * It holds `hostEngineOf(engine)`, never `'custom-api'`: `'none'` for the Yomitan API engine, which
 * installs no host.
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
  /** The main window's view to reopen: Settings for a switch made there, else the Log, Notebook or
   * Anki tab the sidebar's dictionary picker was used from. */
  view: 'settings' | 'log' | 'notebook' | 'anki'
  /** The Settings page (`settingsActiveTab`), so the first frame is that page, not the default. */
  tab: string
  /** Where Back from Settings returns to. */
  back: 'log' | 'notebook' | 'anki'
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
  if (view !== 'settings' && view !== 'log' && view !== 'notebook' && view !== 'anki') return null
  if (typeof tab !== 'string' || !tab) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  // A clock that stepped back a little still counts; a record from the future does not.
  if (now - at > ENGINE_SWITCH_TTL_MS || at - now > 5_000) return null
  return {
    engine: engine as DictionaryEngine,
    view,
    tab,
    back: back === 'notebook' || back === 'anki' ? back : 'log',
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
