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
  return {
    show: true,
    tone: failed ? 'warn' : 'neutral',
    busy: status.phase === 'starting' || status.phase === 'downloading' || status.phase === 'installing',
    text: `${sentence(status.message)}${after}`,
    progress: typeof status.progress === 'number' ? status.progress : null,
    badge: { label: failed ? 'Needs attention' : 'Setting up', tone: 'warn' },
    settingsAvailable: status.settingsReady
  }
}
