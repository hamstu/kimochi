/**
 * What this machine can do: the `platform_capabilities` command's payload
 * (CROSS_PLATFORM_PLAN §3.3), shared by the overlay and the React panels.
 *
 * Native is the only source of platform truth. The default below is used only
 * while it is unknown or when the running backend predates the command, and it
 * is today's macOS behaviour, so an older build loses nothing. The single place
 * that still sniffs the user agent is `fallbackCapabilities`, and only to pick
 * key labels and the OS name for a backend that cannot say.
 */

export type PlatformOs = 'macos' | 'windows' | 'linux'
export type OcrEngineKey = 'cloud' | 'websocket' | 'meikiocr' | 'mangaocr'

export interface OcrEngineCapability {
  available: boolean
  accelerator?: 'coreml' | 'directml' | 'metal' | 'cuda' | 'cpu'
  reason?: string | null
  /**
   * Present when the engine's downloadable models are what keeps it from scanning
   * ("Downloading model… 32%" is then the `reason`). Choosing the engine downloads them.
   */
  model?: 'absent' | 'downloading' | 'paused' | 'failed' | 'verifying' | null
}

export type CaptureAuthorization =
  'granted' | 'denied' | 'notRequired' | 'promptOnSelect' | 'unsupported'
export type KeyTriggerPermission = 'granted' | 'denied' | 'notRequired' | 'unsupported'

export interface PlatformCapabilities {
  os: PlatformOs
  osVersion: string
  arch: string
  session?: {
    backend: 'x11' | 'wayland'
    compositor?: string
    layerShell: boolean
  } | null
  keys: {
    primaryModifier: 'meta' | 'ctrl'
    labels: 'symbols' | 'words'
    superName: 'Command' | 'Win' | 'Super'
  }
  capture: {
    authorization: CaptureAuthorization
    canOpenSettings: boolean
    restartAfterGrant: boolean
    pickerRequired: boolean
    windowCapture: boolean
    excludesOwnWindows: boolean
  }
  sources: {
    catalog: boolean
    thumbnails: boolean
    icons: boolean
    followWindowBounds: boolean
    foregroundTracking: boolean
  }
  overlay: {
    passive: boolean
    inputRegions: 'poll' | 'native' | 'wholeWindowOnly'
    nonActivating: boolean
    nativeHoverWorkaround: boolean
  }
  input: {
    globalShortcuts: boolean
    globalShortcutBackend?: string
    globalShortcutRemediation?: string | null
    keyTrigger: {
      available: boolean
      permission: KeyTriggerPermission
      reason?: string | null
      remediation?: string | null
    }
  }
  ocrEngines: Record<OcrEngineKey, OcrEngineCapability>
  /** The existing `observer_status` payload. */
  observer: unknown
  ownPids: number[]
  ownAppNames: string[]
  tray: boolean
  gamepad: boolean
}

/** The application names Kimochi's own windows have reported as frontmost on macOS. */
export const DEFAULT_OWN_APP_NAMES: readonly string[] = [
  'Kimochi',
  'Kimochi Next',
  'Kimochi Next POC'
]

/**
 * macOS as the app behaves today, for a backend without `platform_capabilities`.
 *
 * Two permissions are unknowable from here and are reported as `denied`, which is
 * what the panels assumed before the command existed: Screen Recording is then
 * decided by the live `permission_status` poll, and key triggering by the
 * `accessibility` flag on the view state.
 */
export const DEFAULT_CAPABILITIES_MACOS: PlatformCapabilities = Object.freeze({
  os: 'macos',
  osVersion: '',
  arch: '',
  session: null,
  keys: { primaryModifier: 'meta', labels: 'symbols', superName: 'Command' },
  capture: {
    authorization: 'denied',
    canOpenSettings: true,
    restartAfterGrant: true,
    pickerRequired: false,
    windowCapture: true,
    excludesOwnWindows: true
  },
  sources: {
    catalog: true,
    thumbnails: true,
    icons: true,
    followWindowBounds: true,
    foregroundTracking: true
  },
  overlay: {
    passive: true,
    inputRegions: 'poll',
    nonActivating: true,
    nativeHoverWorkaround: true
  },
  input: {
    globalShortcuts: true,
    keyTrigger: {
      available: true,
      permission: 'denied',
      reason: null,
      remediation: null
    }
  },
  ocrEngines: {
    cloud: { available: true },
    websocket: { available: true },
    meikiocr: { available: true },
    mangaocr: { available: true }
  },
  observer: null,
  ownPids: [],
  ownAppNames: [...DEFAULT_OWN_APP_NAMES],
  tray: true,
  gamepad: true
}) as PlatformCapabilities

/**
 * The default for this machine when native cannot say: macOS, except that a
 * Windows or Linux user agent gets its own OS name and Ctrl-based keys.
 */
export function fallbackCapabilities(
  nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator
): PlatformCapabilities {
  const hint = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`
  if (!hint.trim() || /Mac|iPhone|iPad|iPod/i.test(hint)) return DEFAULT_CAPABILITIES_MACOS
  const windows = /Win/i.test(hint)
  return {
    ...DEFAULT_CAPABILITIES_MACOS,
    os: windows ? 'windows' : 'linux',
    keys: {
      primaryModifier: 'ctrl',
      labels: 'words',
      superName: windows ? 'Win' : 'Super'
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * A payload from native laid over the default, section by section, so a backend
 * that omits a field (or a whole section) still yields a complete object.
 * Anything that is not an object yields the default itself.
 */
export function normalizeCapabilities(
  raw: unknown,
  base: PlatformCapabilities = fallbackCapabilities()
): PlatformCapabilities {
  if (!isRecord(raw)) return base
  const section = <K extends keyof PlatformCapabilities>(key: K): PlatformCapabilities[K] =>
    (isRecord(raw[key])
      ? { ...(base[key] as object), ...(raw[key] as object) }
      : base[key]) as PlatformCapabilities[K]
  const input = section('input')
  const rawKeyTrigger = isRecord(raw.input) ? raw.input.keyTrigger : undefined
  const engines = { ...base.ocrEngines }
  if (isRecord(raw.ocrEngines)) {
    for (const key of Object.keys(engines) as OcrEngineKey[]) {
      const engine = raw.ocrEngines[key]
      if (isRecord(engine))
        engines[key] = {
          ...engines[key],
          ...(engine as Partial<OcrEngineCapability>)
        }
    }
  }
  const os = raw.os === 'macos' || raw.os === 'windows' || raw.os === 'linux' ? raw.os : base.os
  const names = Array.isArray(raw.ownAppNames)
    ? raw.ownAppNames.filter((name): name is string => typeof name === 'string')
    : base.ownAppNames
  const pids = Array.isArray(raw.ownPids)
    ? raw.ownPids.filter((pid): pid is number => Number.isInteger(pid))
    : base.ownPids
  return {
    ...base,
    os,
    osVersion: typeof raw.osVersion === 'string' ? raw.osVersion : base.osVersion,
    arch: typeof raw.arch === 'string' ? raw.arch : base.arch,
    session: isRecord(raw.session)
      ? (raw.session as PlatformCapabilities['session'])
      : (base.session ?? null),
    keys: section('keys'),
    capture: section('capture'),
    sources: section('sources'),
    overlay: section('overlay'),
    input: {
      ...input,
      keyTrigger: isRecord(rawKeyTrigger)
        ? {
            ...base.input.keyTrigger,
            ...(rawKeyTrigger as Partial<PlatformCapabilities['input']['keyTrigger']>)
          }
        : base.input.keyTrigger
    },
    ocrEngines: engines,
    observer: 'observer' in raw ? raw.observer : base.observer,
    ownPids: pids,
    ownAppNames: names.length ? names : base.ownAppNames,
    tray: typeof raw.tray === 'boolean' ? raw.tray : base.tray,
    gamepad: typeof raw.gamepad === 'boolean' ? raw.gamepad : base.gamepad
  }
}
