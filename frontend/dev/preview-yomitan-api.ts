/**
 * DEV-ONLY: the Yomitan API setup commands for the browser preview (`preview-setup.ts`):
 * `yomitan_host_status`, `yomitan_api_check` and `install_yomitan_native_host`, answering as
 * `src-tauri/src/reader/yomitan_host.rs` and `yomitan_install.rs` would.
 *
 *   ?yapi=flow      (default) nothing installed; Install helper installs Kimochi's helper after
 *                   1.5 s, and the API answers 6 s after that (as if the browser were restarted)
 *   ?yapi=none      nothing installed, and the API never answers (Install still installs)
 *   ?yapi=official  the official Python helper for Chrome and Firefox; the browser is closed
 *   ?yapi=unknown   an unrecognised helper for Brave; the browser is closed
 *   ?yapi=kimochi   Kimochi's helper for Chrome, Brave and Firefox; the browser is closed
 *   ?yapi=broken    a registration whose program is missing
 *   ?yapi=host      installed, and the helper answers, but Yomitan does not through it
 *   ?yapi=ready     installed and connected (Yomitan 26.9.8.0)
 *   ?yapi=fail      nothing installed, and Install fails
 *
 * With ?platform=windows the paths are Windows ones. Pair with ?step=dictionaries&popup=custom-api
 * (onboarding) or ?window=settings&tab=dictionary&popup=custom-api (Settings → Dictionary).
 */
import type { ApiStatus, HostManifest, HostMethod, HostStatus } from '@ui/yomitan-api-setup'

const params = new URLSearchParams(location.search)
const seed = params.get('yapi') ?? 'flow'
const windows = params.get('platform') === 'windows'
const os = windows ? 'windows' : params.get('platform') === 'linux' ? 'linux' : 'macos'

const BROWSERS: Record<string, string> = { chrome: 'Google Chrome', brave: 'Brave', firefox: 'Firefox' }

function manifest(browser: string, method: HostMethod, exists = true): HostManifest {
  const folder = windows
    ? method === 'official'
      ? 'C:\\Users\\you\\yomitan-api'
      : 'C:\\Users\\you\\AppData\\Local\\com.kimochi.app\\yomitan-host'
    : `/Users/you/Library/Application Support/${browser === 'firefox' ? 'Mozilla' : browser === 'brave' ? 'BraveSoftware/Brave-Browser' : 'Google/Chrome'}/NativeMessagingHosts`
  const sep = windows ? '\\' : '/'
  const program =
    method === 'official' ? (windows ? 'yomitan_api.bat' : 'yomitan_api.py') : method === 'kimochi' ? (windows ? 'yomitan-host.exe' : 'yomitan-host-darwin-arm64') : 'my-host'
  return {
    browser,
    browserName: BROWSERS[browser],
    manifestPath: `${folder}${sep}yomitan_api.json`,
    hostPath: `${folder}${sep}${program}`,
    method,
    hostExists: exists,
    problem: exists ? null : 'The program this manifest names is missing.'
  }
}

const SEEDS: Record<string, HostManifest[]> = {
  official: [manifest('chrome', 'official'), manifest('firefox', 'official')],
  unknown: [manifest('brave', 'unknown')],
  kimochi: ['chrome', 'brave', 'firefox'].map((b) => manifest(b, 'kimochi')),
  broken: [manifest('chrome', 'kimochi', false)],
  host: [manifest('chrome', 'kimochi')],
  ready: ['chrome', 'firefox'].map((b) => manifest(b, 'kimochi'))
}

let browsers: HostManifest[] = SEEDS[seed] ?? []
/** When the API starts answering: never, now, or a moment after an install. */
let answersFrom: number | null = seed === 'ready' || seed === 'host' ? 0 : null

function hostStatus(): HostStatus {
  const working = browsers.filter((b) => b.method && b.hostExists && !b.problem)
  const method = (['kimochi', 'official', 'unknown'] as const).find((m) => working.some((b) => b.method === m)) ?? null
  return { os, installed: method !== null, method, browsers }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function apiCheck(args: Record<string, unknown> | undefined): Promise<ApiStatus> {
  const url = String(args?.url ?? '')
  await delay(120)
  const server = answersFrom !== null && Date.now() >= answersFrom
  const yomitan = server && seed !== 'host'
  return {
    url,
    server,
    yomitan,
    yomitanVersion: yomitan ? '26.9.8.0' : null,
    latencyMs: server ? 3 : null,
    error: yomitan ? null : server ? 'Yomitan did not answer through the host (preview)' : 'Nothing is listening at this address.'
  }
}

async function install(): Promise<string> {
  await delay(1500)
  if (seed === 'fail') throw 'Download failed with status: 404 Not Found (preview)'
  browsers = ['chrome', 'brave', 'firefox'].map((b) => manifest(b, 'kimochi'))
  if (seed === 'flow') answersFrom = Date.now() + 6000
  return windows ? 'Host installed (preview).' : 'Installing native messaging host for all browsers on darwin...\n\nDone.'
}

export const YOMITAN_API_HANDLERS: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {
  yomitan_host_status: () => hostStatus(),
  yomitan_api_check: apiCheck,
  install_yomitan_native_host: install
}
