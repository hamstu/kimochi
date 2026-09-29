/**
 * DEV-ONLY: installs a fake Tauri runtime so a real window entry renders in plain Chrome.
 *
 * Every `frontend/dev/*.html` page runs `setupPreview()` and only then dynamically imports the real
 * entry (`../entries/*.tsx`), so the mocks are in place before any app module evaluates.
 *
 * URL parameters:
 *   ?window=<label>  panel window label (controller, settings, log, notebook, capture, debug, stream)
 *   ?tab=<id>        settings tab (mode, shortcuts, gamepad, yomitan, audio, texthooker)
 *   ?theme=light|dark|system  seeds the `appearance` setting (default: system, i.e. the browser's
 *                    prefers-color-scheme; emulate it in DevTools for CSS that reads the media query)
 *   ?scale=small|medium|large|xlarge  seeds the `interfaceScale` setting
 *   ?empty=1         skip demo transcript/notebook seeding (first-run look)
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { SETTINGS_DEFAULTS } from '@ui/settings'
import { mergeHotkeysWithOverrides } from '../vendor/shared-defaults'
import {
  POPOVER_SAMPLE,
  SESSION_IDS,
  SOURCES,
  appIcon,
  seedFilesystem,
  thumbnailSvg
} from './demo-data'

export type PreviewPage = 'panel' | 'reader-popup' | 'source-picker' | 'welcome' | 'tray-popover'

const params = new URLSearchParams(location.search)

const PAGE_LABELS: Record<Exclude<PreviewPage, 'panel'>, string> = {
  'reader-popup': 'reader-popup',
  'source-picker': 'source-picker',
  welcome: 'welcome',
  'tray-popover': 'tray-popover'
}

const CURRENT_SOURCE = SOURCES.find((s) => s.id === 'window:101')!

// ---------------------------------------------------------------- settings store

const settings: Record<string, unknown> = {
  ...structuredClone(SETTINGS_DEFAULTS),
  superTexthooker: { inputSource: 'ocr', deeplApiKey: 'preview-demo-key', fontSizePx: 16 },
  nativeWindowPinned: { log: true },
  texthookerSourceSessions: { 'steins;gate': SESSION_IDS.steinsGate },
  texthookerIngestedHistory: [],
  lastSelectedSource: {
    type: 'window',
    name: CURRENT_SOURCE.name,
    appName: CURRENT_SOURCE.app,
    sourceId: CURRENT_SOURCE.id
  },
  settingsActiveTab: params.get('tab') ?? 'mode',
  ...(params.get('theme') ? { appearance: params.get('theme') } : {}),
  ...(params.get('scale') ? { interfaceScale: params.get('scale') } : {})
}
;(globalThis as Record<string, unknown>).__previewSettings = settings

function publish(key: string, value: unknown): void {
  settings[key] = value
  void emit('settings:changed', { key, value })
}

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
    source: {
      sourceId: CURRENT_SOURCE.id,
      type: 'window',
      name: CURRENT_SOURCE.name,
      appName: CURRENT_SOURCE.app,
      icon: appIcon(CURRENT_SOURCE.app)
    },
    crop: null,
    cropEnabled: false,
    isScanning: false,
    autoOcrEnabled: true,
    overlayVisible: true,
    textOverlayVisible: true,
    debugOverlayVisible: label === 'debug' || label === 'stream' || label === 'capture',
    permission: 'granted',
    frontmostApp: CURRENT_SOURCE.app,
    accessibility: true,
    action: null
  }
}

const DISPLAYS = [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 25, width: 1512, height: 957 },
    scaleFactor: 2
  },
  {
    id: 2,
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
    resizable: label !== 'controller'
  }
}

// ---------------------------------------------------------------- IPC

type Args = Record<string, unknown> | undefined
type Handler = (args: Args, label: string) => unknown

const ok = (): null => null
const note = (what: string, detail: unknown): null => {
  console.info(`[preview] ${what}`, detail)
  return null
}

/** Every command the React windows call, with a plausible response. */
const HANDLERS: Record<string, Handler> = {
  // settings
  settings_get: (a) => settings[String(a?.key)] ?? null,
  settings_set: (a) => publish(String(a?.key), a?.value),
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

  // panels
  panel: (a) => {
    console.info(`[preview] panel(${String(a?.label)}, ${String(a?.action)})`)
    return panelInfo(String(a?.label))
  },
  panel_content_height: ok,
  panel_pointer: () => null,
  panel_cursor: ok,
  view_flags: ok,

  // sources / capture
  enumerate: () =>
    SOURCES.map((s) => ({ id: s.id, kind: s.kind, name: s.name, app: s.app, icon: s.icon, bounds: s.bounds, on_screen: s.on_screen })),
  source_catalog: () =>
    SOURCES.map((s) => ({ id: s.id, kind: s.kind, name: s.name, app: s.app, icon: s.icon })),
  source_picker_state: () => ({
    sourceId: CURRENT_SOURCE.id,
    crop: null,
    editCurrent: params.get('edit') === '1'
  }),
  source_thumbnail: (a) => {
    const s = SOURCES.find((x) => x.id === a?.sourceId)
    return { url: s ? thumbnailSvg(s.name, s.hue, s.kind) : '' }
  },
  source_preview: (a) => {
    const s = SOURCES.find((x) => x.id === a?.sourceId) ?? CURRENT_SOURCE
    return { url: thumbnailSvg(s.name, s.hue, s.kind, 1280, 800), width: 1280, height: 800 }
  },
  source_icon: (a) => ({ icon: appIcon(a?.appName as string) }),
  commit_source: ok,
  select_source: ok,
  selected_source: () => ({ sourceId: CURRENT_SOURCE.id }),
  open_source_picker: ok,
  permission: () => true,
  permission_status: () => 'granted',
  capture_preview: () => ({ frame: null, error: null }),
  capture_frame: () => null,
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
  const label = page === 'panel' ? (params.get('window') ?? 'controller') : PAGE_LABELS[page]
  mockWindows(label, 'controller', 'log', 'settings', 'notebook')
  installIpc(label)
  document.documentElement.dataset.preview = label

  if (params.get('empty') !== '1') await seedFilesystem()

  // The Log window is the texthooker host (sole owner of session files). Every other window that
  // reads reader data is a client of it over events, so run a host in-page for those windows.
  if (page === 'panel' && (label === 'notebook' || label === 'settings')) {
    const { startHost } = await import('../texthooker/host')
    await startHost()
  }
  return label
}
