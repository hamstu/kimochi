/**
 * DEV-ONLY: the UI studio's catalogue of the app's React windows (the overlay and Gaming Mode are
 * in surfaces-overlay.ts). Every control here is a URL parameter the preview pages already read;
 * frontend/dev/preview-setup.ts and its preview-*.ts helpers document what each one does.
 */
import { POPOVER_SAMPLE, SOURCES } from '../demo-data'
import type { ContextAxis, Control, ControlGroup, StudioContext, Surface } from './types'

const opts = (...pairs: [string, string][]): { value: string; label: string }[] =>
  pairs.map(([value, label]) => ({ value, label }))

/** Appearance and platform, offered for every window in the studio's top bar. */
export const GLOBAL_CONTROLS: readonly Control[] = [
  {
    kind: 'select',
    param: 'theme',
    label: 'Appearance',
    default: 'system',
    options: opts(['system', 'System'], ['light', 'Light'], ['dark', 'Dark'])
  },
  {
    kind: 'select',
    param: 'platform',
    label: 'Platform',
    default: 'macos',
    options: opts(['macos', 'macOS'], ['windows', 'Windows'], ['linux', 'Linux'])
  },
  {
    kind: 'select',
    param: 'scale',
    label: 'Interface size',
    default: 'medium',
    options: opts(['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xlarge', 'Extra large'])
  }
]

const SETTINGS_TABS = opts(
  ['general', 'General'],
  ['sources', 'Sources'],
  ['ocr', 'OCR & Overlay'],
  ['log', 'Log'],
  ['dictionary', 'Dictionary'],
  ['assist', 'Translation & AI'],
  ['controls', 'Shortcuts & Controls'],
  ['account', 'Account'],
  ['about', 'About']
)

const in_ = (param: string, ...values: string[]) => (context: StudioContext) =>
  values.includes(context[param] ?? '')

// ---------------------------------------------------------------- shared groups

const UPDATES: ControlGroup = {
  title: 'Updates',
  controls: [
    {
      kind: 'select',
      param: 'update',
      label: 'Self-update',
      default: 'none',
      help: 'The sidebar notice and Settings → About → Updates.',
      options: opts(
        ['none', 'Up to date'],
        ['idle', 'Dev build'],
        ['checking', 'Checking'],
        ['available', 'Update available'],
        ['downloading', 'Downloading'],
        ['ready', 'Ready to restart'],
        ['failed', 'Failed']
      )
    }
  ]
}

const ACCOUNT: ControlGroup = {
  title: 'Account & sync',
  controls: [
    {
      kind: 'select',
      param: 'account',
      label: 'Account',
      default: 'signedout',
      help: 'Signed in turns on Kimochi cloud: Cloud OCR and read-aloud.',
      options: opts(
        ['signedout', 'Signed out'],
        ['linking', 'Linking'],
        ['signedin', 'Signed in'],
        ['full', 'Signed in, storage full'],
        ['suspended', 'Suspended'],
        ['multi', 'Two accounts'],
        ['local', 'Local account']
      )
    },
    {
      kind: 'select',
      param: 'sync',
      label: 'Sync',
      default: 'idle',
      options: opts(['idle', 'Idle'], ['offline', 'Offline'], ['error', 'Error'], ['conflicts', 'Conflicts'])
    },
    {
      kind: 'select',
      param: 'plan',
      label: 'Plan',
      default: 'cloud',
      options: opts(['cloud', 'Cloud'], ['trial', 'Trial'], ['free', 'Free'])
    },
    {
      kind: 'select',
      param: 'name',
      label: 'Display name',
      default: 'short',
      options: opts(['short', 'Hamish'], ['long', 'A very long name'], ['0', 'None'])
    },
    { kind: 'toggle', param: 'avatar', label: 'Avatar picture', on: '1' },
    {
      kind: 'select',
      param: 'server',
      label: 'Server',
      default: 'cloud',
      options: opts(['cloud', 'Kimochi cloud'], ['local', 'Local'], ['forced', 'Local, pinned'])
    }
  ]
}

const DOWNLOADS: ControlGroup = {
  title: 'Downloads',
  controls: [
    {
      kind: 'select',
      param: 'ext',
      label: 'Dictionary engines',
      default: 'absent',
      options: opts(
        ['absent', 'Not downloaded'],
        ['downloading', 'Downloading'],
        ['paused', 'Paused'],
        ['failed', 'Failed'],
        ['verifying', 'Verifying'],
        ['ready', 'Ready']
      )
    },
    {
      kind: 'select',
      param: 'model',
      label: 'OCR models',
      default: 'default',
      help: 'By default MeikiOCR is installed and the others are not.',
      options: opts(
        ['default', 'MeikiOCR only'],
        ['downloading', 'Downloading'],
        ['paused', 'Paused'],
        ['failed', 'Failed'],
        ['ready', 'All installed']
      )
    }
  ]
}

const ENGINE: Control = {
  kind: 'select',
  param: 'popup',
  label: 'Dictionary engine',
  default: 'yomitan',
  options: opts(['yomitan', 'Yomitan'], ['hachidori', 'Hachidori'], ['tenten', '10ten'], ['custom-api', 'Yomitan API'])
}

const YOMITAN_API: Control = {
  kind: 'select',
  param: 'yapi',
  label: 'Yomitan API setup',
  default: 'flow',
  help: 'With the Yomitan API engine chosen.',
  options: opts(
    ['flow', 'Walk through'],
    ['none', 'No browser'],
    ['official', 'Official Yomitan'],
    ['unknown', 'Unknown build'],
    ['kimochi', 'Kimochi build'],
    ['broken', 'Broken'],
    ['host', 'Host missing'],
    ['ready', 'Ready'],
    ['fail', 'Fails']
  )
}

const STEAM: Control = {
  kind: 'select',
  param: 'steam',
  label: 'Steam library',
  default: 'none',
  help: 'A Steam Deck (pick Linux as the platform).',
  options: opts(
    ['none', 'No Steam'],
    ['deck', 'Not added'],
    ['added', 'Added'],
    ['notrunning', 'Steam not running'],
    ['pending', 'Adding'],
    ['fail', 'Adding fails'],
    ['gaming', 'Gaming Mode']
  )
}

const SETTINGS_JSON = {
  key: 'settings',
  label: 'Stored settings',
  help: 'Merged over the defaults as the window loads: any key from ui/settings.ts, e.g. {"ocrMode": "mangaocr", "liveOverlayEnabled": true}.',
  initial: {}
}

// ---------------------------------------------------------------- where the reader is

/** The main window: Log, Notebook or Settings, and the Settings page, read from its document. */
function locateMain(frame: Window): StudioContext {
  const doc = frame.document
  const settings = (frame as unknown as { __previewSettings?: Record<string, unknown> }).__previewSettings
  if (doc.querySelector('.main-settings')) return { view: 'settings', tab: String(settings?.settingsActiveTab ?? 'general') }
  const selected = doc.querySelector('[role="tab"][aria-selected="true"], [role="tab"][data-state="active"]')
  if (selected?.textContent?.trim().toLowerCase().startsWith('notebook')) return { view: 'notebook' }
  return { view: 'log' }
}

/** The welcome guide's steps, each with what the guide needs to show it rather than skip it. */
const WELCOME_STEPS: ContextAxis['options'] = [
  { value: 'intro', label: 'Intro' },
  { value: 'permission', label: 'Screen Recording', params: { permission: 'denied' } },
  { value: 'accessibility', label: 'Accessibility', params: { accessibility: 'denied' } },
  { value: 'ocr', label: 'OCR engine' },
  { value: 'engine', label: 'Dictionary engine' },
  { value: 'dictionaries', label: 'Dictionaries', params: { ext: 'ready' } },
  { value: 'dictionary-settings', label: 'Import or manage', params: { ext: 'ready' } },
  { value: 'steam', label: 'Steam library', params: { platform: 'linux', steam: 'deck' } },
  { value: 'done', label: 'Done' },
  { value: 'error', label: 'Could not save', params: { ext: 'ready' } }
]

/** The welcome guide's routes (WELCOME_ROUTES in preview-setup.ts), back to its `?step=`. */
const WELCOME_ROUTE_STEPS: Record<string, string> = {
  '/': 'intro',
  '/screen-recording-permission': 'permission',
  '/accessibility': 'accessibility',
  '/ocr': 'ocr',
  '/engine': 'engine',
  '/dictionaries': 'dictionaries',
  '/dictionary-settings': 'dictionary-settings',
  '/steam': 'steam',
  '/done': 'done',
  '/main': 'error'
}

function locateWelcome(frame: Window): StudioContext {
  const route = frame.location.hash.replace(/^#/, '') || '/'
  const step = WELCOME_ROUTE_STEPS[route]
  return step ? { step } : {}
}

// ---------------------------------------------------------------- surfaces

const MAIN: Surface = {
  id: 'main',
  group: 'Main window',
  label: 'Main window',
  page: 'panel.html',
  params: { window: 'log' },
  size: { width: 900, height: 560, minWidth: 520, minHeight: 360 },
  contexts: [
    { param: 'view', label: 'View', options: opts(['log', 'Log'], ['notebook', 'Notebook'], ['settings', 'Settings']) },
    { param: 'tab', label: 'Settings page', options: SETTINGS_TABS, when: in_('view', 'settings') }
  ],
  locate: locateMain,
  groups: [
    {
      title: 'Source & scanning',
      controls: [
        {
          kind: 'select',
          param: 'input',
          label: 'Log input',
          default: 'ocr',
          options: opts(['ocr', 'Screen (OCR)'], ['clipboard', 'Clipboard'], ['websocket', 'Texthooker (WebSocket)'])
        },
        { kind: 'toggle', param: 'nosource', label: 'No source chosen', on: '1' },
        {
          kind: 'select',
          param: 'source',
          label: 'Chosen source',
          default: 'window:101',
          options: SOURCES.map((s) => ({ value: s.id, label: s.name }))
        },
        { kind: 'toggle', param: 'auto', label: 'Auto OCR', on: '1', off: '0', default: true },
        { kind: 'toggle', param: 'crop', label: 'Crop region', on: '1' },
        { kind: 'toggle', param: 'quickshot', label: 'Quick Shot', on: '1' },
        { kind: 'toggle', param: 'gamemode', label: 'macOS Game Mode notice', on: '1' },
        {
          kind: 'toggle',
          param: 'session',
          label: 'Steam Deck Gaming Mode',
          on: 'gamescope',
          help: 'Linux under Gamescope: Change source lists its games and apps.'
        },
        { kind: 'toggle', param: 'pick', label: 'System picker cancelled', on: 'cancel', help: 'Linux: the portal shares nothing.' }
      ]
    },
    {
      title: 'Log',
      when: in_('view', 'log', 'notebook'),
      controls: [
        { kind: 'toggle', param: 'empty', label: 'First run (no lines or notebook)', on: '1' },
        { kind: 'toggle', param: 'activity', label: 'Play scan activity', on: '1', help: 'A scripted run of scans on the activity ticker.' },
        { kind: 'toggle', param: 'sidebar', label: 'Sidebar', on: '1', off: '0', default: true },
        {
          kind: 'select',
          param: 'whatsnew',
          label: "What's new",
          default: 'none',
          options: opts(['none', 'Closed'], ['1', 'Open'], ['update', 'After an update'])
        }
      ]
    },
    {
      title: 'Settings page',
      when: in_('view', 'settings'),
      controls: [ENGINE, YOMITAN_API, STEAM]
    },
    UPDATES,
    ACCOUNT,
    DOWNLOADS
  ],
  json: [SETTINGS_JSON]
}

const WELCOME: Surface = {
  id: 'welcome',
  group: 'Welcome guide',
  label: 'Welcome guide',
  page: 'welcome.html',
  size: { width: 720, height: 620, minWidth: 600, minHeight: 520 },
  contexts: { param: 'step', label: 'Step', options: WELCOME_STEPS },
  locate: locateWelcome,
  groups: [
    {
      title: 'Permissions',
      controls: [
        { kind: 'toggle', param: 'permission', label: 'Screen Recording not granted', on: 'denied' },
        {
          kind: 'select',
          param: 'accessibility',
          label: 'Accessibility',
          default: 'granted',
          options: opts(['granted', 'Granted'], ['denied', 'Not granted'], ['none', 'Not needed'])
        },
        { kind: 'toggle', param: 'fullscreen', label: 'Chosen window is full screen', on: '1' },
        { kind: 'toggle', param: 'gamemode', label: 'macOS Game Mode notice', on: '1' }
      ]
    },
    {
      title: 'Dictionary',
      controls: [
        ENGINE,
        YOMITAN_API,
        {
          kind: 'select',
          param: 'dict',
          label: 'Jitendex setup',
          default: 'run',
          options: opts(['run', 'Runs and succeeds'], ['fail', 'Import fails'], ['none', 'Backend unreachable'], ['installed', 'Already set up'])
        }
      ]
    },
    { title: 'Steam Deck', controls: [STEAM] },
    DOWNLOADS
  ],
  json: [SETTINGS_JSON]
}

const POPUP: Surface = {
  id: 'reader-popup',
  group: 'Dictionary',
  label: 'Reader pop-up',
  page: 'reader-popup.html',
  size: { width: 480, height: 360, minWidth: 320, minHeight: 200 },
  groups: [],
  json: [
    {
      key: 'popover',
      label: 'Pop-up content',
      help: 'What `popover:show` carries: the term, its entries (HTML glossaries) and the sentence.',
      initial: POPOVER_SAMPLE
    }
  ]
}

const DIAGNOSTICS: Surface = {
  id: 'diagnostics',
  group: 'Other windows',
  label: 'Diagnostics',
  page: 'panel.html',
  params: { window: 'diagnostics' },
  size: { width: 680, height: 720, minWidth: 480, minHeight: 400 },
  groups: [
    {
      title: 'Capture',
      controls: [
        {
          kind: 'select',
          param: 'capture',
          label: 'Last capture',
          default: 'none',
          options: [{ value: 'none', label: 'None yet' }, ...SOURCES.map((s) => ({ value: s.id, label: s.name }))]
        }
      ]
    }
  ],
  json: [SETTINGS_JSON]
}

const SYNC_LOG: Surface = {
  id: 'sync-log',
  group: 'Other windows',
  label: 'Sync log',
  page: 'panel.html',
  params: { window: 'sync-log', account: 'signedin' },
  size: { width: 760, height: 520, minWidth: 480, minHeight: 320 },
  groups: [ACCOUNT],
  json: [SETTINGS_JSON]
}

export const APP_SURFACES: readonly Surface[] = [MAIN, WELCOME, POPUP, DIAGNOSTICS, SYNC_LOG]
