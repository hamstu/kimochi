/**
 * The Yomitan API setup, as the UI sees it: the native answers (`yomitan_host_status`,
 * `yomitan_api_check`; see COMMANDS.md → Yomitan API setup) and the wording and step logic the
 * onboarding page and the Settings dialog share.
 *
 * Two facts, never merged: whether the browser's native-messaging HELPER is installed (and by
 * which installer), and whether the API ANSWERS. The browser starts the helper only while it is
 * open with Yomitan's "Enable Yomitan API" on, so "installed but not answering" is the normal
 * state of a closed browser, not a broken install.
 */

/** Who installed the helper: Kimochi's Go helper, upstream's Python script, or something else. */
export type HostMethod = 'kimochi' | 'official' | 'unknown'

export interface HostManifest {
  browser: string
  browserName: string
  manifestPath: string
  hostPath: string | null
  /** Null when the manifest could not be read as a Yomitan API manifest. */
  method: HostMethod | null
  hostExists: boolean
  problem: string | null
}

export interface HostStatus {
  os: string
  /** At least one browser has a working registration. */
  installed: boolean
  /** Kimochi's when any working one is, else upstream's, else unknown; null when none works. */
  method: HostMethod | null
  browsers: HostManifest[]
}

export interface ApiStatus {
  url: string
  /** The helper answered (`/serverVersion`): the browser is running it. */
  server: boolean
  /** Yomitan answered through it (`/yomitanVersion`): lookups will work. */
  yomitan: boolean
  yomitanVersion: string | null
  latencyMs: number | null
  error: string | null
}

/** Where the helper serves the API unless the user set another address. */
export const DEFAULT_YOMITAN_API_URL = 'http://127.0.0.1:19633'

/** The API address to use: the one the user typed, else the helper's default. */
export function resolveYomitanApiUrl(customApiUrl: unknown): string {
  return typeof customApiUrl === 'string' && customApiUrl.trim() ? customApiUrl.trim() : DEFAULT_YOMITAN_API_URL
}

export const KIMOCHI_HOST_URL = 'https://github.com/hamstu/go-yomitan-native-messaging-host'
export const OFFICIAL_HOST_URL = 'https://github.com/yomidevs/yomitan-api#installation'

export const METHOD_LABEL: Record<HostMethod, string> = {
  kimochi: "Kimochi's helper",
  official: 'The official Yomitan API helper',
  unknown: 'A Yomitan API helper Kimochi does not recognise'
}

/** "Chrome, Brave and Firefox". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The browsers whose registration works, by name. */
export function workingBrowsers(host: HostStatus): string[] {
  return host.browsers.filter((b) => b.method !== null && b.hostExists && !b.problem).map((b) => b.browserName)
}

/** Registrations that were found but cannot work (a missing program, an unreadable manifest). */
export function brokenBrowsers(host: HostStatus): HostManifest[] {
  return host.browsers.filter((b) => b.method === null || !b.hostExists || b.problem)
}

/** One line on what is installed, for Settings and the wizard. */
export function describeHost(host: HostStatus | null): string {
  if (!host) return 'Checking this computer…'
  if (!host.installed) {
    return host.browsers.length > 0
      ? 'A Yomitan API helper is registered, but its program is missing. Install it again.'
      : 'Not installed.'
  }
  const names = workingBrowsers(host)
  const who = METHOD_LABEL[host.method ?? 'unknown']
  return names.length > 0 ? `${who}, for ${listNames(names)}.` : `${who}.`
}

/** The connection, in a tone and a line. */
export type ConnectionState = 'checking' | 'ready' | 'yomitan-silent' | 'unreachable' | 'not-installed'

export function connectionState(host: HostStatus | null, api: ApiStatus | null): ConnectionState {
  if (api?.yomitan) return 'ready'
  if (api?.server) return 'yomitan-silent'
  if (!api || !host) return 'checking'
  // A helper this computer does not show (another location, another user) can still answer, so
  // the API is asked first; only then does a missing helper explain the silence.
  return host.installed ? 'unreachable' : 'not-installed'
}

export function describeConnection(state: ConnectionState, api: ApiStatus | null): string {
  switch (state) {
    case 'ready':
      return api?.yomitanVersion ? `Connected to Yomitan ${api.yomitanVersion}.` : 'Connected to Yomitan.'
    case 'yomitan-silent':
      return 'The helper is running, but Yomitan did not answer through it yet.'
    case 'unreachable':
      return 'Not connected. Your browser starts the helper: open it, and check that the Yomitan API is turned on.'
    case 'not-installed':
      return 'Not connected: the helper is not installed yet.'
    default:
      return 'Checking…'
  }
}

export const CONNECTION_TONE: Record<ConnectionState, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  ready: 'ok',
  'yomitan-silent': 'warn',
  unreachable: 'warn',
  'not-installed': 'danger',
  checking: 'neutral'
}

/** The wizard's pages, in order. */
export type SetupStep = 'helper' | 'enable' | 'connect'
export const SETUP_STEPS: readonly SetupStep[] = ['helper', 'enable', 'connect']

export const STEP_LABEL: Record<SetupStep, string> = {
  helper: 'Install the helper',
  enable: 'Turn on the API',
  connect: 'Connect'
}

/**
 * Where the wizard opens, once both answers are in: straight to Connect when the API already
 * answers or the helper is installed (then only the browser side can be missing), else the helper.
 */
export function initialStep(host: HostStatus, api: ApiStatus): SetupStep {
  if (api.server || api.yomitan) return 'connect'
  return host.installed ? 'enable' : 'helper'
}

/** Whether a step is already done, for the step list's ticks. */
export function stepDone(step: SetupStep, host: HostStatus | null, api: ApiStatus | null): boolean {
  switch (step) {
    case 'helper':
      // An answering API proves a helper even where the manifests are somewhere unusual.
      return Boolean(host?.installed || api?.server)
    case 'enable':
      // The browser only starts the helper while the setting is on.
      return Boolean(api?.server)
    case 'connect':
      return Boolean(api?.yomitan)
  }
}
