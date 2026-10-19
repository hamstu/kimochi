/**
 * DEV-ONLY: installs a fake Tauri runtime so a real window entry renders in plain Chrome.
 *
 * Every `frontend/dev/*.html` page runs `setupPreview()` and only then dynamically imports the real
 * entry (`../entries/*.tsx`), so the mocks are in place before any app module evaluates.
 *
 * URL parameters:
 *   ?window=<label>  panel window label (log, settings, diagnostics, yomitan)
 *   ?tab=<id>        settings tab (general, sources, ocr, log, dictionary, assist, controls, account)
 *   ?view=notebook   main window: start on the Notebook view
 *   ?sidebar=0       main window: sidebar hidden
 *   ?theme=light|dark|system  seeds the `appearance` setting (default: system, i.e. the browser's
 *                    prefers-color-scheme; emulate it in DevTools for CSS that reads the media query)
 *   ?scale=small|medium|large|xlarge  seeds the `interfaceScale` setting
 *   ?input=ocr|clipboard|websocket  main window: the Log's input source
 *   ?quickshot=1     main window: Quick Shot (with input=ocr)
 *   ?nosource=1      main window: no window or screen chosen yet (choosing one in Change source
 *                    selects it: the view state follows `commit_source`, `clear_source` and the
 *                    Auto OCR and Show overlay switches)
 *   ?auto=0          Auto OCR starts off (default: on)
 *   ?crop=1          main window: the chosen source has a crop region
 *   ?source=<id>     main window: the chosen demo source (e.g. window:106, a tall one)
 *   ?empty=1         skip demo transcript/notebook seeding (first-run look)
 *   ?capture=<id>    diagnostics: serve a capture of that demo source (e.g. window:106, the tall
 *                    one, or window:107, the tiny one) to the Preview and Capture test views
 *   ?platform=windows|linux  `platform_capabilities` answers for that OS (default: macOS); on
 *                    linux the source menu offers "Choose in system picker" (`capture_pick_source`)
 *   ?account=<state> the Kimochi account (preview-account.ts): signedout (default), linking,
 *                    signedin, full, suspended, multi (two accounts), local (an account on this
 *                    computer, Local in use); Settings → Account (?tab=account). Signed in
 *                    (signedin, full, suspended, multi) means `cloudAccess`: Cloud OCR is offered
 *                    and read-aloud shows; signed out (the default) both are hidden
 *   ?sync=<state>    Sync while signed in: idle (default), offline, error, conflicts
 *   ?server=<mode>   the account's server, switched in Settings → Account (`account_set_server`):
 *                    cloud (default), local, forced (local, pinned by KIMOCHI_SERVER)
 *   ?pick=cancel     the system picker shares nothing (default: a fake portal display after 1.5 s)
 *   ?activity=1      main window: play a scripted run of scans on the Log's activity ticker
 *   ?ext=<state>     dictionary-engine downloads (preview-extensions.ts): absent (default), downloading,
 *                    paused, failed, verifying, ready
 *   ?model=<state>   OCR model downloads (preview-models.ts)
 *   ?update=<state>  self-updates (preview-updates.ts): none (default), idle, checking, available,
 *                    downloading, ready, failed; the sidebar notice and Settings → General → Updates
 *   ?whatsnew=1      main window: What's new open on load (the sample changelog in preview-updates.ts;
 *                    add ?update=available for the offered release's notes on top)
 *   ?whatsnew=update main window: the first launch after an update (`lastSeenVersion` is an older
 *                    version), so What's new opens on its own once the update status arrives
 *
 * Reader pop-up (reader-popup.html):
 *   ?popover=message  show what the parent frame posts instead of the sample (`listenForPopover`)
 *
 * Onboarding (welcome.html):
 *   ?step=intro|permission|accessibility|picker|ocr|engine|dictionaries|dictionary-settings|done|error
 *                    open that step (error: the last step's save failed). Every step stays
 *                    navigable from there; ?platform=linux makes the capture step the picker
 *   ?permission=denied  macOS Screen Recording not granted yet (default: granted)
 *   ?accessibility=denied  macOS Accessibility not granted yet (default: granted; `none` for
 *                          a platform without it)
 *   ?fullscreen=1       the chosen window is a full-screen app
 *   ?gamemode=1         macOS Game Mode is throttling the overlay (its notice under Show overlay)
 *   ?popup=hachidori|tenten|custom-api  the dictionary engine already chosen (the setup step
 *                    follows it; custom-api is the Yomitan API wizard)
 *   ?yapi=<state>    the Yomitan API setup (preview-yomitan-api.ts): flow (default), none,
 *                    official, unknown, kimochi, broken, host, ready, fail; for the wizard in
 *                    onboarding and in Settings → Dictionary (?tab=dictionary&popup=custom-api)
 *   ?dict=fail|none  Jitendex quick setup fails while importing, or Yomitan's backend is not
 *                    reachable (default: Set up Jitendex runs through every stage in about 6 s)
 *   ?embed=1         embedded in the marketing site's live demo (vite.demo.config.ts builds this page
 *                    into site/public/demo/): the lines the site's game plays are left out of the
 *                    seeded log, the page never moves focus until clicked and never scrolls its
 *                    parent, and it takes `postMessage` commands from the same-origin parent
 *                    (see `listenToEmbedder`)
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit, listen } from '@tauri-apps/api/event'
import { DICTIONARY_ENGINE_KEY, SETTINGS_DEFAULTS, nextOverlayToggle } from '@ui/settings'
import { DEFAULT_CAPABILITIES_MACOS, type PlatformCapabilities } from '@ui/capabilities'
import { mergeHotkeysWithOverrides } from '../vendor/shared-defaults'
import {
  POPOVER_SAMPLE,
  SESSION_IDS,
  SOURCES,
  THUMBNAIL_EDGE,
  appIcon,
  seedFilesystem,
  thumbnailSvg,
  type DemoSource
} from './demo-data'
import { MODEL_HANDLERS, onModelSettingSet } from './preview-models'
import { EXTENSION_HANDLERS, startSeededDownloads } from './preview-extensions'
import { UPDATE_HANDLERS } from './preview-updates'
import { YOMITAN_API_HANDLERS } from './preview-yomitan-api'
import { ACCOUNT_HANDLERS, PREVIEW_SIGNED_IN } from './preview-account'

export type PreviewPage = 'panel' | 'reader-popup' | 'welcome' | 'tray-popover'

const params = new URLSearchParams(location.search)

const PAGE_LABELS: Record<Exclude<PreviewPage, 'panel'>, string> = {
  'reader-popup': 'reader-popup',
  welcome: 'welcome',
  'tray-popover': 'tray-popover'
}

const EMBED = params.get('embed') === '1'

/**
 * Embedded in the site's demo, the desktop is the site's: its own windows (the game, and the
 * Easter-egg app) come and go as the visitor opens and closes them (`sources` from the parent), so
 * only open ones are offered; the demo's other app windows are left out, the screens stay.
 */
const EGG_SOURCE: DemoSource = {
  id: 'window:900',
  kind: 'window',
  name: 'ありがとう',
  app: 'おまけ',
  hue: 40,
  on_screen: true,
  bounds: { x: 300, y: 200, width: 640, height: 400 }
}
const ALL_SOURCES: DemoSource[] = EMBED ? [...SOURCES, EGG_SOURCE] : SOURCES
let openWindows: string[] | null = null
function catalog(): DemoSource[] {
  if (!EMBED) return SOURCES
  return ALL_SOURCES.filter((s) => s.kind === 'display' || (openWindows ?? ['window:101']).includes(s.id))
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
  // The Game Mode notice shows under an overlay that is on.
  ...(params.get('gamemode') === '1' ? { liveOverlayEnabled: true } : {}),
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
  // `?whatsnew=update`: an older version was last seen, as after an update (the mock runs 0.1.0).
  ...(params.get('whatsnew') === 'update' ? { lastSeenVersion: '0.0.2' } : {}),
  // `?popup=hachidori` stands in for a stored engine (the store is in memory, so a reload resets it).
  ...(params.get('popup') ? { yomitanSettings: { popupType: params.get('popup'), customApiUrl: '' } } : {}),
  mainSidebarOpen: params.get('sidebar') !== '0',
  quickShotEnabled: params.get('quickshot') === '1',
  ...(params.get('theme') ? { appearance: params.get('theme') } : {}),
  ...(params.get('scale') ? { interfaceScale: params.get('scale') } : {}),
  // The marketing demo reads as the app does on a desktop: MeikiOCR (what its Log lines say they
  // were read with) and the overlay on.
  ...(params.get('embed') === '1' ? { ocrMode: 'meikiocr', liveOverlayEnabled: true } : {})
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
    capture: {
      ...DEFAULT_CAPABILITIES_MACOS.capture,
      authorization: params.get('permission') === 'denied' ? 'denied' : 'granted'
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
      input: { globalShortcuts: true },
      ocrEngines: {
        googlelens: { available: true },
        cloud: { available: true },
        meikiocr: { available: true, accelerator: 'directml' },
        mangaocr: { available: false, reason: 'Not available on Windows yet' },
        livetext: { available: false, reason: 'Apple Live Text is available on macOS only.' },
        oneocr: { available: true }
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
      input: { globalShortcuts: false },
      ocrEngines: {
        googlelens: { available: true },
        cloud: { available: true },
        meikiocr: { available: true, accelerator: 'cpu' },
        mangaocr: { available: true, accelerator: 'cpu' },
        livetext: { available: false, reason: 'Apple Live Text is available on macOS only.' },
        oneocr: { available: false, reason: 'OneOCR is available on Windows only.' }
      },
      ownAppNames: ['kimochi'],
      tray: false
    }
  }
  return mac
}

/**
 * A signed-in `?account=`: Kimochi cloud, as native reports it (the token itself never leaves
 * Rust).
 */
function withCloudAccess(capabilities: PlatformCapabilities): PlatformCapabilities {
  if (PREVIEW_SIGNED_IN) return { ...capabilities, cloudAccess: true }
  return {
    ...capabilities,
    cloudAccess: false,
    ocrEngines: {
      ...capabilities.ocrEngines,
      cloud: {
        available: false,
        reason: 'Sign in to a Kimochi account (Settings → Account) to use Kimochi cloud OCR.'
      }
    }
  }
}

const CAPABILITIES = withCloudAccess(previewCapabilities())

// ---------------------------------------------------------------- view state

/** What the switches and the source menu change; `pushState` sends the new view to the page. */
const live = {
  revision: 1,
  source: params.get('nosource') === '1' ? null : CURRENT_SOURCE,
  autoOcr: params.get('auto') !== '0',
  textOverlayVisible: true
}
let pageLabel = 'log'

function pushState(): void {
  live.revision += 1
  void emit('state', viewState(pageLabel))
  tellEmbedder({ type: 'state', sourceId: live.source?.id ?? null, autoOcr: live.autoOcr, overlay: live.textOverlayVisible })
}

/** Embedded: tell the site's demo something (`{kimochiDemoEvent: 1, type, …}`). */
function tellEmbedder(message: Record<string, unknown>): void {
  if (EMBED) parent.postMessage({ kimochiDemoEvent: 1, ...message }, location.origin)
}

/** The window the chosen source was, kept while it is closed so it comes back when reopened. */
let closedSource: DemoSource | null = null

/** The parent's desktop changed: a window opened or closed. */
function setOpenWindows(ids: string[]): void {
  openWindows = ids
  if (live.source?.kind === 'window' && !ids.includes(live.source.id)) {
    closedSource = live.source
    live.source = null
    pushState()
  } else if (!live.source && closedSource && ids.includes(closedSource.id)) {
    live.source = closedSource
    closedSource = null
    pushState()
  }
}

function viewState(label: string): Record<string, unknown> {
  const source = live.source
  return {
    revision: live.revision,
    status: 'Ready',
    scan: null,
    logs: [],
    regions: {},
    sourceFocus: { focused: true, present: true, held: false },
    overlayThrottled: params.get('gamemode') === '1',
    origin: CURRENT_SOURCE.bounds,
    interactive: false,
    dictionary: false,
    dismiss: 0,
    source: source && {
      sourceId: source.id,
      type: source.kind === 'display' ? 'screen' : 'window',
      name: source.name,
      appName: source.app,
      icon: source.app ? appIcon(source.app) : undefined
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
    autoOcrEnabled: live.autoOcr,
    overlayVisible: true,
    textOverlayVisible: live.textOverlayVisible,
    debugOverlayVisible: label === 'diagnostics',
    permission: 'granted',
    frontmostApp: CURRENT_SOURCE.app,
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

let liveMini = false

function panelInfo(label: string): Record<string, unknown> {
  return {
    label,
    mini: label === 'log' && liveMini,
    native: { level: 3, opaque: false, ignores_mouse: false },
    bounds: { x: 200, y: 120, width: innerWidth, height: innerHeight },
    scale: devicePixelRatio,
    pinned: label === 'log' || label === 'welcome',
    focused: true,
    resizable: label !== 'tray-popover'
  }
}

// ---------------------------------------------------------------- demo stops (?embed=1)

/**
 * Embedded, what the demo cannot really do stops at the site's "Try the real thing" window (its
 * offer to download) instead of half-working: `{kimochiDemoEvent: 1, type: 'unavailable', feature}`.
 * Only the visitor's own clicks and keys are stopped, never the demo's script or the page's own
 * background calls.
 *
 * New features need no entry here to stay safe: a command this file does not mock, or a setting
 * outside `DEMO_SETTINGS`, that the visitor's click reaches is stopped the same way. The lists below
 * are for what IS mocked (for the UI preview pages) but means nothing on the site.
 */
const DEMO_STOPPED_COMMANDS: Record<string, string> = {
  open_source_picker: 'The system picker',
  capture_pick_source: 'The system picker',
  dictionary_engine_apply: 'Switching dictionaries',
  hotkeys_save: 'Shortcuts',
  open_screen_capture_preferences: 'Screen recording',
  request_accessibility: 'Accessibility',
  model_download_start: 'Downloading OCR models',
  extension_download_start: 'Downloading dictionaries',
  install_yomitan_native_host: 'The Yomitan API',
  account_link_start: 'Kimochi accounts',
  account_open_web: 'Kimochi accounts',
  sync_now: 'Sync',
  update_check: 'Updates',
  anki_add_note: 'Adding cards to Anki',
  anki_gui_browse: 'Anki',
  deepl_translate: 'Translation',
  cloud_translate: 'Translation',
  explain_run: 'Explanations',
  tts_speak: 'Read aloud',
  vndb_search_vns: 'VNDB'
}

/** `trigger_action` names that need a real screen: the region editor, scans on demand. */
const DEMO_STOPPED_ACTIONS: Record<string, string> = {
  setCropArea: 'Choosing a scan area',
  selectAndScan: 'Scanning a selected area',
  triggerScan: 'Scanning on demand',
  toggleDebugOverlay: 'Diagnostics'
}

/** Settings the demo shows the effect of; any other the visitor changes is stopped. */
const DEMO_SETTINGS = new Set([
  'appearance',
  'interfaceScale',
  'mainSidebarOpen',
  'mainSidebarWidth',
  'liveOverlayEnabled',
  'lastSelectedSource',
  'settingsActiveTab',
  'superTexthooker',
  'texthookerSourceSessions',
  'texthookerIngestedHistory'
])

/** What a stopped setting is called on the site, for the ones the demo's own controls reach. */
const DEMO_SETTING_LABELS: Record<string, string> = {
  ocrMode: 'Switching OCR models',
  yomitanSettings: 'Switching dictionaries'
}

/** When the visitor last pressed or typed in this page (trusted events only). */
let lastGesture = -Infinity
const byVisitor = (): boolean => performance.now() - lastGesture < 2000

function demoStop(feature: string): null {
  tellEmbedder({ type: 'unavailable', feature })
  return null
}

/** The demo's stop for this call, or null to let it through. */
function stoppedFeature(cmd: string, args: Args, mocked: boolean): string | null {
  if (!byVisitor()) return null
  if (cmd in DEMO_STOPPED_COMMANDS) return DEMO_STOPPED_COMMANDS[cmd]
  if (cmd === 'trigger_action') return DEMO_STOPPED_ACTIONS[String(args?.name)] ?? null
  // Clearing a crop area: the demo's sources have none.
  if (cmd === 'commit_source' && args?.keepCrop === false) return 'Choosing a scan area'
  if (cmd === 'panel' && args?.action === 'show' && args?.label !== 'log') return 'That window'
  if (cmd === 'settings_set' && !DEMO_SETTINGS.has(String(args?.key)))
    return DEMO_SETTING_LABELS[String(args?.key)] ?? 'Changing that setting'
  // Something new the demo knows nothing about.
  if (!mocked && !cmd.startsWith('plugin:')) return 'That'
  return null
}

function installDemoStops(): void {
  const mark = (event: Event): void => {
    if (event.isTrusted) lastGesture = performance.now()
  }
  addEventListener('pointerdown', mark, { capture: true })
  addEventListener('keydown', mark, { capture: true })
  ;(window as unknown as { __kimochiDemoStop: (feature: string) => boolean }).__kimochiDemoStop = (feature) => {
    demoStop(feature)
    return true
  }
  // A visitor's earlier switch is mirrored in this origin's storage, and the demo only has Yomitan:
  // without this, every later visit would look for the Hachidori or 10ten host.
  try {
    localStorage.removeItem(DICTIONARY_ENGINE_KEY)
  } catch {
    // Storage blocked: nothing was mirrored either.
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

/**
 * `?popover=message`: the reader pop-up shows what its parent frame posts instead of the sample,
 * as `{ type: 'kimochi-preview-popover', theme: 'light' | 'dark', payload }` (a `popover:show`
 * payload). The dictionary preview scene (frontend/dev/dictionary-preview.html) feeds it one Yomitan API
 * answer this way. It is told `{ type: 'kimochi-preview-popover-ready' }` once listening.
 */
function listenForPopover(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; theme?: string; payload?: unknown } | null
    if (data?.type !== 'kimochi-preview-popover') return
    void emit('popover:theme', data.theme === 'dark' ? 'dark' : 'light').then(() =>
      emit('popover:show', data.payload)
    )
  })
  // The notebook card's "Notebook →" asks the main window to open the entry, then hides the pop-up;
  // embedded, both go to the page that opened this one (`showEmbeddedPopover`).
  void listen<{ entryId: string }>('notebook:edit-request', ({ payload }) =>
    window.parent.postMessage({ type: 'kimochi-preview-popover-notebook', entryId: payload.entryId }, location.origin)
  )
  window.parent.postMessage({ type: 'kimochi-preview-popover-ready' }, '*')
}

/** Every command the React windows call, with a plausible response. */
const HANDLERS: Record<string, Handler> = {
  ...MODEL_HANDLERS,
  ...EXTENSION_HANDLERS,
  ...UPDATE_HANDLERS,
  ...YOMITAN_API_HANDLERS,
  ...ACCOUNT_HANDLERS,
  // settings
  settings_get: (a) => settings[String(a?.key)] ?? null,
  settings_set: (a) => {
    if (a?.key === 'hasCompletedOnboarding' && params.get('step') === 'error')
      throw 'io: the settings file is read-only (preview)'
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
  tts_speak: () => {
    if (!CAPABILITIES.cloudAccess)
      throw 'native: Read aloud runs on Kimochi cloud. Sign in from Settings → Account to use it.'
    throw 'native: text to speech is not available in the browser preview'
  },

  // panels
  panel: (a) => {
    console.info(`[preview] panel(${String(a?.label)}, ${String(a?.action)})`)
    const action = String(a?.action)
    if (action === 'mini' || action === 'expand') liveMini = action === 'mini'
    // Embedded, the site's desktop sizes, hides and shows the window.
    if (['mini', 'expand', 'minimize', 'hide'].includes(action)) tellEmbedder({ type: 'window', action })
    return panelInfo(String(a?.label))
  },
  panel_drag: (a) => {
    console.info(`[preview] panel_drag(${String(a?.label)})`)
    embedDrag?.()
    return panelInfo(String(a?.label))
  },
  panel_content_height: ok,
  panel_pointer: () => null,
  panel_cursor: ok,
  view_flags: ok,

  // sources / capture
  enumerate: () =>
    catalog().map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      app: s.app,
      icon: s.icon,
      bounds: s.bounds,
      on_screen: s.on_screen
    })),
  source_catalog: () =>
    catalog().map((s) => ({ id: s.id, kind: s.kind, name: s.name, app: s.app, icon: s.icon, space: s.space })),
  source_thumbnail: (a) => {
    const s = ALL_SOURCES.find((x) => x.id === a?.sourceId)
    if (!s) return { url: '' }
    const { width, height } = s.bounds
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height))
    return { url: thumbnailSvg(s.name, s.hue, s.kind, width, height, scale) }
  },
  // Each call a slightly different frame, so the sidebar's crossfade is visible.
  source_live_thumbnail: (a) => {
    const s = ALL_SOURCES.find((x) => x.id === a?.sourceId) ?? CURRENT_SOURCE
    const { width, height } = s.bounds
    const hue = (s.hue + (liveTick++ % 6) * 24) % 360
    return { url: thumbnailSvg(s.name, hue, s.kind, width, height, 0.5), width, height }
  },
  source_preview: (a) => {
    const s = ALL_SOURCES.find((x) => x.id === a?.sourceId) ?? CURRENT_SOURCE
    const { width, height } = s.bounds
    return { url: thumbnailSvg(s.name, s.hue, s.kind, width, height), width, height }
  },
  source_icon: (a) => ({ icon: appIcon(a?.appName as string) }),
  commit_source: (a) => {
    const chosen = ALL_SOURCES.find((x) => x.id === a?.sourceId)
    if (chosen) {
      live.source = chosen
      closedSource = null
      publish('lastSelectedSource', {
        type: chosen.kind === 'display' ? 'screen' : 'window',
        name: chosen.name,
        appName: chosen.app,
        sourceId: chosen.id
      })
      pushState()
    }
    return { sourceId: a?.sourceId ?? null, crop: null, key: '' }
  },
  clear_source: () => {
    live.source = null
    closedSource = null
    publish('lastSelectedSource', null)
    pushState()
    return { sourceId: null, previous: null }
  },
  activate_source: (a) => {
    tellEmbedder({ type: 'activate', sourceId: a?.sourceId ?? null })
    return note('activate_source', a?.sourceId)
  },
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
  permission_status: () => (params.get('permission') === 'denied' ? 'denied' : 'granted'),
  accessibility_status: () =>
    params.get('accessibility') === 'none' ? null : params.get('accessibility') !== 'denied',
  request_accessibility: () => false,
  source_window_state: () =>
    params.get('nosource') === '1'
      ? null
      : {
          sourceId: CURRENT_SOURCE.id,
          fullscreen: params.get('fullscreen') === '1',
          onScreen: true,
          settling: false
        },
  capture_preview: () => ({ frame: demoCapture(), error: null }),
  capture_frame: () => demoCapture(),
  scan: () => null,
  clear: ok,
  activity_post: (a) => {
    void emit('activity', { text: a?.text, tone: a?.tone ?? 'info', key: a?.key ?? null, at: Date.now() })
    return null
  },

  // actions
  trigger_action: (a) => {
    if (a?.name === 'toggleAutoOcr') {
      live.autoOcr = !live.autoOcr
      pushState()
    } else if (a?.name === 'toggleTextOverlay') {
      const next = nextOverlayToggle({
        liveOverlayEnabled: Boolean(settings.liveOverlayEnabled),
        textOverlayVisible: live.textOverlayVisible
      })
      if (next.liveOverlayEnabled !== settings.liveOverlayEnabled) publish('liveOverlayEnabled', next.liveOverlayEnabled)
      live.textOverlayVisible = next.textOverlayVisible
      pushState()
    }
    return note('trigger_action', a?.name)
  },
  app_quit: () => {
    tellEmbedder({ type: 'window', action: 'close' })
    return null
  },
  dictionary: ok,
  texthooker_send: ok,
  open_screen_capture_preferences: ok,
  history_add: ok,
  history_delete: ok,
  history_clear: ok,
  history_merge_reset: ok,

  // hotkeys
  hotkeys_load: () => mergeHotkeysWithOverrides({}),
  hotkeys_save: ok,
  hotkeys_reapply: () => ({ registered: [], failed: [] }),
  hotkeys_suspend: ok,

  // reader / popover
  show_popover: (a) => {
    if (params.get('embed') === '1' && a?.kind === 'notebook') showEmbeddedPopover(a)
    return note('show_popover', a)
  },
  hide_popover: () => {
    hideEmbeddedPopover()
    if (params.get('popover') === 'message') window.parent.postMessage({ type: 'kimochi-preview-popover-hide' }, location.origin)
    return null
  },
  reader_popup_ready: () => {
    if (params.get('popover') === 'message') {
      listenForPopover()
      return null
    }
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
  // Native reloads the reader windows; there are none to reload in the preview.
  dictionary_engine_apply: () => note('dictionary_engine_apply', null),
  // The preview's dictionary answers from these mocks, so whichever engine is asked about is up.
  dictionary_runtime_status: (a) => ({
    engine: (a?.engine as string) ?? 'yomitan',
    phase: 'ready',
    settingsReady: true,
    message: 'Ready.'
  }),

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
      if (EMBED) {
        const feature = stoppedFeature(cmd, args as Args, Boolean(handler))
        if (feature) {
          // A stopped setting snaps back to what it was, once `useSetting` listens again (it
          // ignores changes for 100 ms after its own write).
          if (cmd === 'settings_set') {
            const key = String((args as Args)?.key)
            setTimeout(() => publish(key, settings[key]), 150)
          }
          return demoStop(feature)
        }
      }
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

// ---------------------------------------------------------------- activity script

/** Set once an embedding page drives the activity ticker itself. */
let scriptStopped = false

/** `?activity=1`: what the overlay and native post during a few scans, on a loop. */
function playActivity(): void {
  type Step = [delayMs: number, text: string, tone: string, key?: string]
  const steps: Step[] = [
    [1200, 'Auto-scan on', 'info', 'auto-scan'],
    [1500, 'Scanning…', 'busy', 'scan'],
    [400, 'Recognising with MeikiOCR…', 'busy', 'scan'],
    [900, 'Added 2 lines', 'ok', 'scan'],
    [2500, 'Scanning…', 'busy', 'scan'],
    [700, 'Same text as before, not added', 'info', 'scan'],
    [2500, 'Scanning…', 'busy', 'scan'],
    [600, 'Nothing recognised', 'warn', 'scan'],
    [1500, 'Scanning…', 'busy', 'scan'],
    [600, 'Nothing recognised', 'warn', 'scan'],
    [2000, 'Downloading Manga OCR model… 12%', 'busy', 'model:mangaocr'],
    [1000, 'Downloading Manga OCR model… 47%', 'busy', 'model:mangaocr'],
    [1000, 'Downloading Manga OCR model… 88%', 'busy', 'model:mangaocr'],
    [1000, 'Manga OCR model ready', 'ok', 'model:mangaocr'],
    [2500, 'Scanning…', 'busy', 'scan'],
    [800, 'OCR failed: OCR HTTP 429: quota exceeded', 'error', 'scan']
  ]
  let index = 0
  const next = (): void => {
    const [delay, text, tone, key] = steps[index++ % steps.length]
    setTimeout(() => {
      if (scriptStopped) return
      void emit('activity', { text, tone, key: key ?? null, at: Date.now() })
      next()
    }, delay)
  }
  next()
}

// ---------------------------------------------------------------- embedding (?embed=1)

/** A command from the embedding page (site/src/demo/). */
type EmbedMessage =
  | { kimochiDemo: 1; type: 'scan'; engine?: string }
  | { kimochiDemo: 1; type: 'line'; text: string; engine?: string }
  | { kimochiDemo: 1; type: 'theme'; value: 'light' | 'dark' }
  | { kimochiDemo: 1; type: 'interactive'; value: boolean }
  | { kimochiDemo: 1; type: 'sidebar'; value: boolean }
  | { kimochiDemo: 1; type: 'sources'; open: string[] }

let embedScan = 0

/**
 * Embedded, a title-bar drag (`panel_drag`) is the embedding page's to perform: it moves the
 * iframe like a window. The drag is reported in screen coordinates, which stay put while the
 * iframe moves under the pointer: `{kimochiDemoEvent: 1, type: 'drag', phase, x, y}`.
 */
let embedDrag: (() => void) | null = null

/**
 * Commands from the same-origin parent: `scan` shows a scan starting on the activity ticker, `line`
 * ingests a recognised line exactly as an OCR scan does (through the texthooker host, so the Log
 * appends, counts and tokenizes it), `theme` switches the appearance setting without a reload, and
 * `interactive` lets the page take focus (a click inside the page does the same).
 */
function listenToEmbedder(): void {
  let interactive = false
  // No focus moves until the visitor clicks in the page (or the parent says so), and never a
  // scrollIntoView that reaches the parent page.
  let pressed: { x: number; y: number } | null = null
  addEventListener(
    'pointerdown',
    (event) => {
      interactive = true
      pressed = { x: event.screenX, y: event.screenY }
      // The visitor's own click (the demo's scripted pointer dispatches untrusted events).
      if (event.isTrusted) tellEmbedder({ type: 'interact' })
    },
    { capture: true }
  )
  const tell = (phase: 'start' | 'move' | 'end', x: number, y: number): void =>
    parent.postMessage({ kimochiDemoEvent: 1, type: 'drag', phase, x, y }, location.origin)
  embedDrag = () => {
    if (!pressed) return
    tell('start', pressed.x, pressed.y)
    // A press that began in this page keeps sending it the pointer, even outside the iframe.
    const move = (event: MouseEvent): void => tell('move', event.screenX, event.screenY)
    const up = (event: MouseEvent): void => {
      removeEventListener('mousemove', move)
      tell('end', event.screenX, event.screenY)
    }
    addEventListener('mousemove', move)
    addEventListener('mouseup', up, { once: true })
  }
  const focus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (interactive) focus.call(this, { ...options, preventScroll: true })
  }
  Element.prototype.scrollIntoView = function (this: Element) {
    for (let el = this.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 1) continue
      const overflow = getComputedStyle(el).overflowY
      if (overflow !== 'auto' && overflow !== 'scroll') continue
      const box = this.getBoundingClientRect()
      const port = el.getBoundingClientRect()
      if (box.top < port.top) el.scrollTop += box.top - port.top
      else if (box.bottom > port.bottom) el.scrollTop += box.bottom - port.bottom
      return
    }
  }
  addEventListener('message', (event: MessageEvent<EmbedMessage>) => {
    if (event.origin !== location.origin || event.data?.kimochiDemo !== 1) return
    const message = event.data
    const engine = 'engine' in message && message.engine ? message.engine : 'MeikiOCR'
    if (message.type === 'scan') {
      scriptStopped = true
      void emit('activity', { text: 'Scanning…', tone: 'busy', key: 'scan', at: Date.now() })
      setTimeout(
        () => void emit('activity', { text: `Recognising with ${engine}…`, tone: 'busy', key: 'scan', at: Date.now() }),
        350
      )
    } else if (message.type === 'line') {
      scriptStopped = true
      const scanId = `embed-${++embedScan}`
      // OCR lines skip the host's text dedupe (native dedupes scans), so a looping demo keeps adding.
      const ocr = { scanId, groupId: `${scanId}:0`, groupIndex: 0, groupCount: 1, engine: 'meikiocr', orientation: 'horizontal' }
      void emit('reader:request', {
        id: scanId,
        module: 'host',
        method: 'ingest',
        args: [message.text, 'ocr', Date.now(), scanId, ocr]
      })
      void emit('activity', { text: 'Added 1 line', tone: 'ok', key: 'scan', at: Date.now() })
    } else if (message.type === 'theme') {
      publish('appearance', message.value)
    } else if (message.type === 'interactive') {
      interactive = message.value
    } else if (message.type === 'sidebar') {
      publish('mainSidebarOpen', message.value)
    } else if (message.type === 'sources') {
      setOpenWindows(message.open)
    }
  })
}

// ---------------------------------------------------------------- WebSocket input (?embed=1)

/**
 * A visitor who picks WebSocket in the site's demo has no texthooker to connect to, and a retrying
 * socket would only put an error on the page: sockets to other hosts open at once and stay silent.
 * The page's own host (Vite's dev connection) still gets a real one.
 */
function quietWebSockets(): void {
  const Real = window.WebSocket
  class QuietSocket extends EventTarget {
    readyState = 1
    url: string
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    constructor(url: string) {
      super()
      this.url = url
      setTimeout(() => this.onopen?.(new Event('open')), 50)
    }
    send(): void {}
    close(): void {
      this.readyState = 3
    }
  }
  window.WebSocket = function (url: string | URL, protocols?: string | string[]) {
    if (new URL(String(url), location.href).host === location.host) return new Real(url, protocols)
    return new QuietSocket(String(url))
  } as unknown as typeof WebSocket
}

// ---------------------------------------------------------------- notebook pop-up (?embed=1)

/**
 * The app opens a notebook chip's card in its own pop-up window (`show_popover`). Embedded there
 * is no such window, so the real pop-up page (reader-popup.html, which shows what its parent posts)
 * opens in an iframe beside the pointer, inside this page. A click elsewhere or Escape closes it.
 */
let popoverFrame: HTMLIFrameElement | null = null
/** The last pop-up's window, kept after it closes: it hides itself before asking for the notebook. */
let popoverWindow: Window | null = null
let lastPointer = { x: 0, y: 0 }
addEventListener('pointerdown', (event) => (lastPointer = { x: event.clientX, y: event.clientY }), { capture: true })

function hideEmbeddedPopover(): void {
  popoverFrame?.remove()
  popoverFrame = null
}

/** The pop-up page's transparent margin around its card, for the card's shadow (popover.css). */
const POPOVER_PAD = 16

function showEmbeddedPopover(a: Record<string, unknown>): void {
  hideEmbeddedPopover()
  const width = Math.min(Number(a.width) || 360, innerWidth - 16)
  const height = Math.min(Number(a.height) || 320, innerHeight - 16)
  const left = Math.max(8, Math.min(lastPointer.x - width / 2, innerWidth - width - 8))
  const below = lastPointer.y + 14
  const top = below + height <= innerHeight - 8 ? below : Math.max(8, lastPointer.y - height - 14)
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  const frame = document.createElement('iframe')
  frame.src = `reader-popup.html?popover=message&empty=1&theme=${theme}`
  frame.title = 'Notebook entry'
  // Sized and placed like the app's pop-up window: the card, plus a transparent margin for its own
  // border and shadow. The frame's colour scheme matches the page inside, or Chrome paints it opaque.
  Object.assign(frame.style, {
    position: 'fixed',
    left: `${left - POPOVER_PAD}px`,
    top: `${top - POPOVER_PAD}px`,
    width: `${width + POPOVER_PAD * 2}px`,
    height: `${height + POPOVER_PAD * 2}px`,
    border: '0',
    background: 'transparent',
    zIndex: '2147483647',
    colorScheme: theme
  })
  const payload = { kind: 'notebook', entry: a.notebookEntry, sentence: a.sentence ?? null }
  const onReady = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow || event.data?.type !== 'kimochi-preview-popover-ready') return
    removeEventListener('message', onReady)
    frame.contentWindow?.postMessage({ type: 'kimochi-preview-popover', theme, payload }, location.origin)
  }
  addEventListener('message', onReady)
  document.body.append(frame)
  popoverFrame = frame
  popoverWindow = frame.contentWindow
}

addEventListener('pointerdown', (event) => {
  if (popoverFrame && !(event.target as Element | null)?.closest?.('.notebook-chip')) hideEmbeddedPopover()
})
addEventListener('message', (event: MessageEvent) => {
  if (!popoverWindow || event.source !== popoverWindow) return
  if (event.data?.type === 'kimochi-preview-popover-hide') hideEmbeddedPopover()
  if (event.data?.type === 'kimochi-preview-popover-notebook') {
    hideEmbeddedPopover()
    // What the app's pop-up sends the main window: open the Notebook on this entry.
    void emit('notebook:edit-request', { entryId: event.data.entryId })
  }
})
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideEmbeddedPopover()
})

// ---------------------------------------------------------------- dictionary relay stub

// `preloadPanelDictionary` imports `/ui/panel-yomitan.js` (the engine resolves to Yomitan here: no
// mirror, no prelude); vite.preview.config.ts serves a stub there.

// ---------------------------------------------------------------- onboarding (welcome.html)

const WELCOME_ROUTES: Record<string, string> = {
  intro: '/',
  permission: '/screen-recording-permission',
  accessibility: '/accessibility',
  picker: '/system-picker',
  ocr: '/ocr',
  engine: '/engine',
  dictionaries: '/dictionaries',
  'dictionary-settings': '/dictionary-settings',
  done: '/done',
  error: '/main'
}

/** The stages Yomitan's quick setup (`ui/setup-dictionaries.js`) reports, with a fake clock. */
function installDictionarySetup(): void {
  if (params.get('dict') === 'none') return
  const fail = params.get('dict') === 'fail'
  let started = 0
  const job = (): Record<string, unknown> => {
    const t = Date.now() - started
    if (t < 1500) return { id: 'job-1', stage: 'downloading' }
    if (t < 4500 || fail) {
      if (fail && t >= 2500)
        return { id: 'job-1', stage: 'failed', error: 'Dictionary import failed: the archive is incomplete (preview).' }
      return { id: 'job-1', stage: 'importing', progress: { index: Math.min(12, Math.round((t - 1500) / 250)), count: 12 } }
    }
    if (t < 5200) return { id: 'job-1', stage: 'verifying' }
    if (t < 5800) return { id: 'job-1', stage: 'enabling' }
    return { id: 'job-1', stage: 'complete', title: 'Jitendex.org [2026-10-01]', entries: 287_431 }
  }
  ;(window as unknown as { __extensionHost: unknown }).__extensionHost = {
    toBackend: async ({ params: request }: { params: { command: string } }) => {
      switch (request.command) {
        case 'catalog':
          return {
            catalog: [
              {
                id: 'jitendex',
                title: 'Jitendex',
                description:
                  'Japanese–English definitions. Downloads on demand; nothing is installed without your choice.'
              }
            ],
            dictionaries: []
          }
        case 'start':
          started = Date.now()
          return { id: 'job-1' }
        case 'status':
          return job()
        case 'practice':
          return { text: '日本語', matches: 12 }
        default:
          return null
      }
    }
  }
}

function setupWelcome(): void {
  const route = WELCOME_ROUTES[params.get('step') ?? '']
  if (route) history.replaceState(null, '', `${location.pathname}${location.search}#${route}`)
  installDictionarySetup()
}

// ---------------------------------------------------------------- entry point

export async function setupPreview(page: PreviewPage): Promise<string> {
  const label = page === 'panel' ? (params.get('window') ?? 'log') : PAGE_LABELS[page]
  pageLabel = label
  mockWindows(label, 'log', 'settings', 'diagnostics', 'sync-log')
  installIpc(label)
  startSeededDownloads()
  document.documentElement.dataset.preview = label
  if (page === 'welcome') setupWelcome()

  const embed = params.get('embed') === '1'
  if (embed) {
    listenToEmbedder()
    installDemoStops()
    quietWebSockets()
    // Keep on top means nothing on a page.
    const style = document.createElement('style')
    style.textContent = 'button[aria-label="Keep on top"], button[aria-label="Unpin window"] { display: none !important; }'
    document.head.append(style)
    tellEmbedder({ type: 'state', sourceId: live.source?.id ?? null, autoOcr: live.autoOcr, overlay: live.textOverlayVisible })
  }
  if (params.get('empty') !== '1') await seedFilesystem({ omitPlayed: embed })
  if (params.get('activity') === '1') playActivity()

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
