/**
 * What the Settings → Dictionary panel, the sidebar's dictionary picker, Settings → Anki and
 * onboarding say about the engine in use, as pure decisions (COMMANDS.md
 * `dictionary_runtime_status`).
 *
 * Two facts are combined: the engine's DOWNLOAD (`extension_status`: is its release on this
 * computer) and its live READINESS (`dictionary-readiness`: has its host started, are its
 * dictionaries in). An engine that is not downloaded runs nowhere, so its readiness is never
 * reported and would read "Starting the dictionary…" forever; the download decides first.
 */

export type ReadinessPhase = 'starting' | 'downloading' | 'installing' | 'setup-needed' | 'ready' | 'failed'

export interface ReadinessStatus {
  phase: ReadinessPhase
  message: string
  /** The host's settings pages can open (its background has started). */
  settingsReady: boolean
  progress?: number | null
  /** Lookups work now, whatever the phase (10ten reads its bundled words while it downloads). */
  lookups?: boolean
}

/** The engine's download state (`ExtensionStatus.state`), or null when there is none (the Yomitan API, an older backend). */
export type DownloadState = 'absent' | 'downloading' | 'paused' | 'failed' | 'verifying' | 'ready' | null

export interface ReadinessView {
  /** Whether there is anything to say: nothing once the engine is ready. */
  show: boolean
  tone: 'neutral' | 'warn'
  /** Something is under way (a spinner beside the text). */
  busy: boolean
  text: string
  /** The same in a word or two, for inside the sidebar's select while it is busy ("Starting…", "42%"). */
  short: string
  /** When it needs the reader: a few words for the sidebar's notice ("Not downloaded yet."). */
  notice: string
  /** A percentage for a progress bar, when the engine gives one. */
  progress: number | null
  /** The chooser's badge for the engine in use. */
  badge: { label: string; tone: 'accent' | 'warn' }
  /** Its own settings page can be opened ("Open <engine> settings"). */
  settingsAvailable: boolean
}

/**
 * Whether the readiness `next` replaces `current`: the newer report wins (native numbers each one,
 * `seq`). A window reads the status once and then follows the event, and the two travel
 * separately: a read answered just before the host reported "ready" can arrive after that event,
 * and taking it would leave "Starting…" up for good.
 */
export function newerReadiness(
  current: { engine: string; seq?: number } | null,
  next: { engine: string; seq?: number }
): boolean {
  if (!current || current.engine !== next.engine) return true
  return (next.seq ?? 0) >= (current.seq ?? 0)
}

const sentence = (text: string): string => {
  const trimmed = text.trim()
  return !trimmed || /[.!?…:]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

export function readinessView(status: ReadinessStatus, download: DownloadState, name: string): ReadinessView {
  const downloaded = download === null || download === 'ready'
  if (!downloaded) {
    const under = download === 'downloading' || download === 'verifying'
    return {
      show: true,
      tone: under ? 'neutral' : 'warn',
      busy: under,
      text: under
        ? `Downloading ${name}. Words are looked up once it is ready.`
        : `${name} is not downloaded yet, so words are not looked up. Download it in Settings → Dictionary.`,
      short: under ? 'Downloading…' : 'Not downloaded',
      notice: under ? '' : 'Not downloaded yet.',
      progress: null,
      badge: { label: under ? 'Downloading' : 'Not downloaded', tone: 'warn' },
      settingsAvailable: false
    }
  }
  if (status.phase === 'ready') {
    return {
      show: false,
      tone: 'neutral',
      busy: false,
      text: '',
      short: '',
      notice: '',
      progress: null,
      badge: { label: 'Active', tone: 'accent' },
      settingsAvailable: status.settingsReady
    }
  }
  const failed = status.phase === 'failed'
  // 10ten looks words up from its bundled list while its full dictionaries download; a failure
  // needs the user, and is not "setup" that completes on its own.
  const after = failed
    ? ''
    : status.lookups === true
      ? ' Words are already looked up meanwhile.'
      : ' Words are looked up once setup is complete.'
  const progress = typeof status.progress === 'number' ? status.progress : null
  const short =
    status.phase === 'starting'
      ? 'Starting…'
      : status.phase === 'downloading'
        ? progress !== null
          ? `${Math.floor(progress)}%`
          : 'Downloading…'
        : status.phase === 'installing'
          ? 'Installing…'
          : failed
            ? 'Failed'
            : 'Needs setup'
  return {
    show: true,
    tone: failed ? 'warn' : 'neutral',
    busy: status.phase === 'starting' || status.phase === 'downloading' || status.phase === 'installing',
    text: `${sentence(status.message)}${after}`,
    short,
    notice: failed ? 'Setup failed.' : status.phase === 'setup-needed' ? 'Needs setting up.' : '',
    progress,
    badge: { label: failed ? 'Needs attention' : 'Setting up', tone: 'warn' },
    settingsAvailable: status.settingsReady
  }
}

/**
 * An engine's whole setup as ONE bar, 0–100, so it is plain when all of it is done: its download
 * (when the setup began with one), its start, its dictionary data and its install, each a fixed
 * share. `exact` is false within a step that reports no progress of its own (starting,
 * installing, verifying), which the bar shows as a pulse at that step's start. Null once there is
 * nothing under way.
 */
export function setupProgress(
  status: ReadinessStatus,
  download: DownloadState,
  /** The engine download's own percentage, while it downloads. */
  downloadPercent: number | null,
  /** The setup began with the engine's download (it is a step of this bar). */
  withDownload: boolean
): { value: number; exact: boolean } | null {
  // [start, end] of each step, out of 100.
  const steps = withDownload
    ? { download: [0, 50], starting: [50, 56], data: [56, 94], installing: [94, 100] }
    : { download: [0, 0], starting: [0, 10], data: [10, 90], installing: [90, 100] }
  const within = ([from, to]: number[], percent: number | null): { value: number; exact: boolean } =>
    percent === null
      ? { value: from, exact: false }
      : { value: from + ((to - from) * Math.min(Math.max(percent, 0), 100)) / 100, exact: true }
  if (download === 'downloading') return within(steps.download, downloadPercent)
  if (download === 'verifying') return { value: steps.download[1], exact: false }
  if (download !== null && download !== 'ready') return null
  switch (status.phase) {
    case 'starting':
      return within(steps.starting, null)
    case 'downloading':
      return within(steps.data, typeof status.progress === 'number' ? status.progress : null)
    case 'installing':
      return within(steps.installing, null)
    default:
      return null
  }
}
