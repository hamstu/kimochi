/**
 * DEV-ONLY: installs a fake Tauri runtime so a real window entry renders in plain Chrome.
 *
 * Every `frontend/dev/*.html` page runs `setupPreview()` and only then dynamically imports the real
 * entry (`../entries/*.tsx`), so the mocks are in place before any app module evaluates.
 *
 * URL parameters:
 *   ?window=<label>  panel window label (log, settings, diagnostics, yomitan)
 *   ?tab=<id>        settings tab (general, sources, ocr, log, dictionary, assist, controls)
 *   ?view=notebook   main window: start on the Notebook view
 *   ?sidebar=0       main window: sidebar hidden
 *   ?theme=light|dark|system  seeds the `appearance` setting (default: system, i.e. the browser's
 *                    prefers-color-scheme; emulate it in DevTools for CSS that reads the media query)
 *   ?scale=small|medium|large|xlarge  seeds the `interfaceScale` setting
 *   ?input=ocr|clipboard|websocket  main window: the Log's input source
 *   ?quickshot=1     main window: Quick Shot (with input=ocr)
 *   ?nosource=1      main window: no window or screen chosen yet
 *   ?crop=1          main window: the chosen source has a crop region
 *   ?source=<id>     main window: the chosen demo source (e.g. window:106, a tall one)
 *   ?empty=1         skip demo transcript/notebook seeding (first-run look)
 *   ?capture=<id>    diagnostics: serve a capture of that demo source (e.g. window:106, the tall
 *                    one, or window:107, the tiny one) to the Preview and Capture test views
 *   ?platform=windows|linux  `platform_capabilities` answers for that OS (default: macOS); on
 *                    linux the source menu offers "Choose in system picker" (`capture_pick_source`)
 *   ?pick=cancel     the system picker shares nothing (default: a fake portal display after 1.5 s)
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { SETTINGS_DEFAULTS } from '@ui/settings'
import { DEFAULT_CAPABILITIES_MACOS, type PlatformCapabilities } from '@ui/capabilities'
import { mergeHotkeysWithOverrides } from '../vendor/shared-defaults'
import {
  POPOVER_SAMPLE,
  SESSION_IDS,
  SOURCES,
  THUMBNAIL_EDGE,
  appIcon,
  seedFilesystem,
  thumbnailSvg
} from './demo-data'
import { MODEL_HANDLERS, onModelSettingSet } from './preview-models'

export type PreviewPage = 'panel' | 'reader-popup' | 'welcome' | 'tray-popover'

const params = new URLSearchParams(location.search)

const PAGE_LABELS: Record<Exclude<PreviewPage, 'panel'>, string> = {
  'reader-popup': 'reader-popup',
  welcome: 'welcome',
  'tray-popover': 'tray-popover'
}

const CURRENT_SOURCE =
  SOURCES.find((s) => s.id === params.get('source')) ?? SOURCES.find((s) => s.id === 'window:101')!

/** `?capture=<source id>`: a fake last capture of that source; otherwise none yet. */
function demoCapture(): unknown {
  const s = SOURCES.find((x) => x.id === params.get('capture'))
  if (!s) return null
  const { width, height } = s.bounds
  const info = { source_id: s.id, width, height, full_width: width, full_height: height }
  return {
    id: 1,
    url: thumbnailSvg(s.name, s.hue, s.kind, width, height),
    info: { ...info, capturedAt: Date.now() }
  }
}

// ---------------------------------------------------------------- settings store

const settings: Record<string, unknown> = {
  ...structuredClone(SETTINGS_DEFAULTS),
  superTexthooker: {
    inputSource: params.get('input') ?? 'ocr',
    deeplApiKey: 'preview-demo-key',
    fontSizePx: 16
  },
  nativeWindowPinned: { log: true },
  texthookerSourceSessions: { 'steins;gate': SESSION_IDS.steinsGate },
  texthookerIngestedHistory: [],
  lastSelectedSource: {
    type: 'window',
    name: CURRENT_SOURCE.name,
    appName: CURRENT_SOURCE.app,
    sourceId: CURRENT_SOURCE.id
  },
  settingsActiveTab: params.get('tab') ?? 'general',
  mainSidebarOpen: params.get('sidebar') !== '0',
  quickShotEnabled: params.get('quickshot') === '1',
  ...(params.get('theme') ? { appearance: params.get('theme') } : {}),
  ...(params.get('scale') ? { interfaceScale: params.get('scale') } : {})
}
;(globalThis as Record<string, unknown>).__previewSettings = settings

function publish(key: string, value: unknown): void {
  settings[key] = value
  void emit('settings:changed', { key, value })
}

// ---------------------------------------------------------------- platform

/** `?platform=`: macOS by default; Windows and Linux shaped as their backends will report. */
function previewCapabilities(): PlatformCapabilities {
  const mac: PlatformCapabilities = {
    ...DEFAULT_CAPABILITIES_MACOS,
    osVersion: '15.5',
    arch: 'aarch64',
    capture: { ...DEFAULT_CAPABILITIES_MACOS.capture, authorization: 'granted' },
    input: {
      ...DEFAULT_CAPABILITIES_MACOS.input,
      keyTrigger: { ...DEFAULT_CAPABILITIES_MACOS.input.keyTrigger, permission: 'granted' }
    },
    ownPids: [4242]
  }
  const platform = params.get('platform')
  if (platform === 'windows') {
    return {
      ...mac,
      os: 'windows',
      osVersion: '10.0.26100',
      arch: 'x86_64',
      keys: { primaryModifier: 'ctrl', labels: 'words', superName: 'Win' },
      capture: {
        authorization: 'notRequired',
        canOpenSettings: false,
        restartAfterGrant: false,
        pickerRequired: false,
        windowCapture: true,
        excludesOwnWindows: true
      },
      overlay: { passive: true, inputRegions: 'native', nonActivating: true, nativeHoverWorkaround: false },
      input: {
        globalShortcuts: true,
        keyTrigger: {
          available: false,
          permission: 'unsupported',
          reason: 'Watching key presses in other applications is not available on Windows yet.',
          remediation: 'Use the gamepad trigger or the scan shortcut instead.'
        }
      },
      ocrEngines: {
        cloud: { available: true },
        websocket: { available: true },
        meikiocr: { available: true, accelerator: 'directml' },
        mangaocr: { available: false, reason: 'Not available on Windows yet' }
      },
      ownAppNames: ['Kimochi', 'kimochi.exe']
    }
  }
  if (platform === 'linux') {
    return {
      ...mac,
      os: 'linux',
      osVersion: '6.8',
      arch: 'x86_64',
      session: { backend: 'wayland', compositor: 'gnome', layerShell: false },
      keys: { primaryModifier: 'ctrl', labels: 'words', superName: 'Super' },
      capture: {
        authorization: 'promptOnSelect',
        canOpenSettings: false,
        restartAfterGrant: false,
        pickerRequired: true,
        windowCapture: false,
        excludesOwnWindows: false
      },
      sources: { catalog: false, thumbnails: false, icons: false, followWindowBounds: false, foregroundTracking: false },
      overlay: { passive: false, inputRegions: 'wholeWindowOnly', nonActivating: false, nativeHoverWorkaround: false },
      input: {
        globalShortcuts: false,
        keyTrigger: {
          available: false,
          permission: 'unsupported',
          reason: 'Wayland does not let applications watch key presses in other windows.',
          remediation: null
        }
      },
      ocrEngines: {
        cloud: { available: true },
        websocket: { available: true },
        meikiocr: { available: true, accelerator: 'cpu' },
        mangaocr: { available: true, accelerator: 'cpu' }
      },
      ownAppNames: ['kimochi'],
      tray: false
    }
  }
  return mac
}

const CAPABILITIES = previewCapabilities()

// ---------------------------------------------------------------- view state

function viewState(label: string): Record<string, unknown> {
  return {
    revision: 1,
    status: 'Ready',
    scan: null,
    logs: [],
    regions: {},
    sourceFocus: { focused: true, present: true, held: false },
    origin: CURRENT_SOURCE.bounds,
    interactive: false,
    dictionary: false,
    dismiss: 0,
    source:
      params.get('nosource') === '1'
        ? null
        : {
            sourceId: CURRENT_SOURCE.id,
            type: 'window',
            name: CURRENT_SOURCE.name,
            appName: CURRENT_SOURCE.app,
            icon: appIcon(CURRENT_SOURCE.app)
          },
    crop:
      params.get('crop') === '1'
        ? {
            x: 40,
            y: CURRENT_SOURCE.bounds.height - 140,
            width: CURRENT_SOURCE.bounds.width - 80,
            height: 116,
            reference_width: CURRENT_SOURCE.bounds.width,
            reference_height: CURRENT_SOURCE.bounds.height
          }
        : null,
    cropEnabled: params.get('crop') === '1',
    isScanning: false,
    autoOcrEnabled: true,
    overlayVisible: true,
    textOverlayVisible: true,
    debugOverlayVisible: label === 'diagnostics',
    permission: 'granted',
    frontmostApp: CURRENT_SOURCE.app,
    accessibility: true,
    action: null
  }
}

const DISPLAYS = [
  {
    id: 1,
    source_id: 'macos:display:1',
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 25, width: 1512, height: 957 },
    scaleFactor: 2
  },
  {
    id: 2,
    source_id: 'macos:display:2',
    bounds: { x: 1512, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1512, y: 25, width: 2560, height: 1415 },
    scaleFactor: 1
  }
]

function panelInfo(label: string): Record<string, unknown> {
  return {
    label,
    native: { level: 3, opaque: false, ignores_mouse: false },
    bounds: { x: 200, y: 120, width: innerWidth, height: innerHeight },
    scale: devicePixelRatio,
    pinned: label === 'log',
    focused: true,
    resizable: label !== 'tray-popover'
  }
}

// ---------------------------------------------------------------- IPC

let liveTick = 0

type Args = Record<string, unknown> | undefined
type Handler = (args: Args, label: string) => unknown

const ok = (): null => null
const note = (what: string, detail: unknown): null => {
  console.info(`[preview] ${what}`, detail)
  return null
}

/** Every command the React windows call, with a plausible response. */
const HANDLERS: Record<string, Handler> = {
  ...MODEL_HANDLERS,
  // settings
  settings_get: (a) => settings[String(a?.key)] ?? null,
  settings_set: (a) => {
    publish(String(a?.key), a?.value)
    onModelSettingSet(String(a?.key), a?.value)
    return null
  },
  settings_all: () => ({ ...settings }),
  reader_settings_patch: (a) => {
    const current = (settings.superTexthooker as Record<string, unknown>) ?? {}
    publish('superTexthooker', { ...current, ...((a?.patch as object) ?? {}) })
  },

  // state
  snapshot: (_a, label) => viewState(label),
  system_state: () => ({ frontmostApp: CURRENT_SOURCE.app, displays: DISPLAYS, awake: true }),
  desktop: () => DISPLAYS.map((d) => d.bounds),
  displays: () => DISPLAYS,
  platform_capabilities: () => CAPABILITIES,

  // panels
  panel: (a) => {
    console.info(`[preview] panel(${String(a?.label)}, ${String(a?.action)})`)
    return panelInfo(String(a?.label))
  },
  panel_drag: (a) => {
    console.info(`[preview] panel_drag(${String(a?.label)})`)
    return panelInfo(String(a?.label))
  },
  panel_content_height: ok,
  panel_pointer: () => null,
  panel_cursor: ok,
  view_flags: ok,

  // sources / capture
  enumerate: () =>
    SOURCES.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      app: s.app,
      icon: s.icon,
      bounds: s.bounds,
      on_screen: s.on_screen
    })),
  source_catalog: () =>
    SOURCES.map((s) => ({ id: s.id, kind: s.kind, name: s.name, app: s.app, icon: s.icon })),
  source_thumbnail: (a) => {
    const s = SOURCES.find((x) => x.id === a?.sourceId)
    if (!s) return { url: '' }
    const { width, height } = s.bounds
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height))
    return { url: thumbnailSvg(s.name, s.hue, s.kind, width, height, scale) }
  },
  // Each call a slightly different frame, so the sidebar's crossfade is visible.
  source_live_thumbnail: (a) => {
    const s = SOURCES.find((x) => x.id === a?.sourceId) ?? CURRENT_SOURCE
    const { width, height } = s.bounds
    const hue = (s.hue + (liveTick++ % 6) * 24) % 360
    return { url: thumbnailSvg(s.name, hue, s.kind, width, height, 0.5), width, height }
  },
  source_preview: (a) => {
    const s = SOURCES.find((x) => x.id === a?.sourceId) ?? CURRENT_SOURCE
    const { width, height } = s.bounds
    return { url: thumbnailSvg(s.name, s.hue, s.kind, width, height), width, height }
  },
  source_icon: (a) => ({ icon: appIcon(a?.appName as string) }),
  commit_source: ok,
  activate_source: (a) => note('activate_source', a?.sourceId),
  select_source: ok,
  selected_source: () => ({ sourceId: CURRENT_SOURCE.id }),
  open_source_picker: ok,
  // The system picker (a Wayland portal): the dialog takes as long as the user does.
  capture_pick_source: () =>
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(
            params.get('pick') === 'cancel'
              ? {
                  picked: false,
                  reason: 'cancelled',
                  message:
                    'Nothing was shared. The system picker was closed, timed out or could not open; try again.'
                }
              : {
                  picked: true,
                  source: {
                    id: 'portal:display:57',
                    kind: 'display',
                    name: 'Built-in display',
                    app: null,
                    bounds: { x: 0, y: 0, width: 1512, height: 982 },
                    on_screen: true,
                    icon: null
                  },
                  selection: { sourceId: 'portal:display:57', crop: null, key: 'Built-in display' }
                }
          ),
        1500
      )
    ),
  permission: () => true,
  permission_status: () => 'granted',
  capture_preview: () => ({ frame: demoCapture(), error: null }),
  capture_frame: () => demoCapture(),
  scan: () => null,
  clear: ok,

  // actions
  trigger_action: (a) => note('trigger_action', a?.name),
  app_quit: ok,
  dictionary: ok,
  texthooker_send: ok,
  open_screen_capture_preferences: ok,
  open_accessibility_preferences: ok,
  history_add: ok,
  history_delete: ok,
  history_clear: ok,

  // hotkeys
  hotkeys_load: () => mergeHotkeysWithOverrides({}),
  hotkeys_save: ok,
  hotkeys_reapply: () => ({ registered: [], failed: [] }),
  hotkeys_suspend: ok,

  // reader / popover
  show_popover: (a) => note('show_popover', a),
  hide_popover: ok,
  reader_popup_ready: () => {
    setTimeout(() => {
      const dark = matchMedia('(prefers-color-scheme: dark)').matches
      void emit('popover:theme', dark ? 'dark' : 'light')
      void emit('popover:show', POPOVER_SAMPLE)
    }, 0)
    return null
  },
  reader_popup_focus: ok,
  reader_notebook_ack: () => true,

  // dictionary
  yomitan_probe: () => 12,
  yomitan_request: () => null,
  yomitan_tokenize: () => [],
  yomitan_ankifields: () => ({ fields: [], audioMedia: [], dictionaryMedia: [] }),
  install_yomitan_native_host: () => 'Installed (preview).',

  // anki
  anki_probe: () => 18,
  anki_deck_names: () => ['Default', 'Mining', 'Japanese::VN'],
  anki_model_names: () => ['Basic', 'Lapis', 'Kiku'],
  anki_model_field_names: () => ['Expression', 'Reading', 'Glossary', 'Sentence', 'Audio'],
  anki_find_notes: () => [],
  anki_gui_browse: ok,
  anki_store_media_file: () => 'preview.mp3',
  anki_add_note: () => 1,

  // translate / explain / vndb
  deepl_translate: () => '(Preview) Machine translation would appear here.',
  explain_run: ok,
  explain_cancel: ok,
  vndb_search_vns: () => ({ results: [], more: false }),
  vndb_characters_by_vn: () => ({ results: [], more: false }),
  vndb_fetch_image: () => ({ base64: '', mime: 'image/png' })
}

const warned = new Set<string>()

function installIpc(label: string): void {
  mockIPC(
    (cmd, args) => {
      const handler = HANDLERS[cmd]
      if (handler) return handler(args as Args, label)
      if (cmd === 'plugin:window|is_visible') return true
      if (cmd === 'plugin:window|is_focused') return true
      if (cmd === 'plugin:window|scale_factor') return devicePixelRatio
      if (cmd.startsWith('plugin:')) return null
      if (!warned.has(cmd)) {
        warned.add(cmd)
        console.warn(`[preview] unmocked command "${cmd}" resolved null`, args)
      }
      return null
    },
    { shouldMockEvents: true }
  )
}

// ---------------------------------------------------------------- dictionary relay stub

// `preloadPanelYomitan` imports `/ui/panel-yomitan.js`; vite.preview.config.ts serves a stub there.

// ---------------------------------------------------------------- entry point

export async function setupPreview(page: PreviewPage): Promise<string> {
  const label = page === 'panel' ? (params.get('window') ?? 'log') : PAGE_LABELS[page]
  mockWindows(label, 'log', 'settings', 'diagnostics')
  installIpc(label)
  document.documentElement.dataset.preview = label

  if (params.get('empty') !== '1') await seedFilesystem()

  // The Log window is the texthooker host (sole owner of session files). Every other window that
  // reads reader data is a client of it over events, so run a host in-page for those windows.
  // Started late, as in the app, where the Log is another window: a page must render (and wait)
  // before the host's first snapshot arrives.
  if (page === 'panel' && label === 'settings') {
    setTimeout(() => {
      void import('../texthooker/host').then(({ startHost }) => startHost())
    }, 600)
  }
  return label
}
