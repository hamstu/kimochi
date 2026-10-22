/**
 * Self-updates, as the UI sees them: the `update_status` reply and `update-status` event payload
 * (`UpdateStatus` in `src-tauri/src/updater.rs`), and the pure wording and decisions the
 * sidebar notice and Settings → About → Updates share.
 */
import { formatBytes, percent, progressText } from './model-download.js'

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'none'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'failed'
export type UpdateStage = 'check' | 'download' | 'install'
export type UpdateAction = 'check' | 'download' | 'cancel' | 'install' | 'retry' | 'dismiss'

export interface UpdateStatus {
  state: UpdateState
  /** The running build's version. */
  currentVersion: string
  /** The offered version (available and later). */
  version: string | null
  notes: string | null
  /** When the release was published (RFC 3339). */
  date: string | null
  /** The bundle's size in bytes, when the manifest names it. */
  size: number | null
  receivedBytes: number | null
  totalBytes: number | null
  /** Why it failed. */
  message: string | null
  /** Which step failed. */
  stage: UpdateStage | null
  /** When the last successful check finished, in milliseconds since the epoch. */
  checkedAt: number | null
  /** The user put the offer away for this run. */
  dismissed: boolean
  /** Whether this build checks on its own (a bundle, not `tauri dev`). */
  automatic: boolean
}

const STATES: readonly UpdateState[] = [
  'idle',
  'checking',
  'none',
  'available',
  'downloading',
  'ready',
  'installing',
  'failed'
]
const STAGES: readonly UpdateStage[] = ['check', 'download', 'install']

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** A native payload as an `UpdateStatus`, or null when it is not one (an older backend, a mock). */
export function normalizeUpdateStatus(raw: unknown): UpdateStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!STATES.includes(r.state as UpdateState) || typeof r.currentVersion !== 'string') return null
  return {
    state: r.state as UpdateState,
    currentVersion: r.currentVersion,
    version: text(r.version),
    notes: text(r.notes),
    date: text(r.date),
    size: count(r.size),
    receivedBytes: count(r.receivedBytes),
    totalBytes: count(r.totalBytes),
    message: text(r.message),
    stage: STAGES.includes(r.stage as UpdateStage) ? (r.stage as UpdateStage) : null,
    checkedAt: count(r.checkedAt),
    dismissed: r.dismissed === true,
    automatic: r.automatic === true
  }
}

/** "just now", "4 minutes ago", "2 hours ago", "yesterday", "3 days ago". */
export function relativeTime(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/**
 * Whether an update is in play: offered, downloading, downloaded, installing, or stuck after
 * the user started one. A failed *check* is not: it only concerns the Check button.
 */
export function updateInPlay(status: UpdateStatus): boolean {
  switch (status.state) {
    case 'available':
    case 'downloading':
    case 'ready':
    case 'installing':
      return true
    case 'failed':
      return status.stage === 'download' || status.stage === 'install'
    default:
      return false
  }
}

/**
 * Whether the sidebar notice shows: an update in play that the user has not put away. "Not
 * now" hides an offer or a failure; a download they start, or a new version, brings it back.
 */
export const noticeShown = (status: UpdateStatus | null): boolean =>
  status !== null &&
  updateInPlay(status) &&
  !(status.dismissed && (status.state === 'available' || status.state === 'failed'))

const named = (status: UpdateStatus): string =>
  status.version ? `Kimochi ${status.version}` : 'A new version'

/** The notice's first line. */
export function noticeTitle(status: UpdateStatus): string {
  switch (status.state) {
    case 'downloading':
      return `Downloading ${named(status)}`
    case 'ready':
      return `${named(status)} is ready`
    case 'installing':
      return `Installing ${named(status)}…`
    case 'failed':
      return status.stage === 'install' ? 'Could not install the update' : 'Download failed'
    default:
      return `${named(status)} is available`
  }
}

/** The notice's second line: the size, the progress, the next step, or what went wrong. */
export function noticeDetail(status: UpdateStatus): string | null {
  switch (status.state) {
    case 'available':
      return status.size ? `${formatBytes(status.size)} download` : null
    case 'downloading':
      return downloadProgress(status)
    case 'ready':
      return 'Restart Kimochi to finish updating.'
    case 'installing':
      return 'Kimochi restarts when this is done.'
    case 'failed':
      return status.message
    default:
      return null
  }
}

/** "12 MB of 90 MB", or "12 MB" while the total is unknown. */
export function downloadProgress(status: UpdateStatus): string {
  const received = status.receivedBytes ?? 0
  const total = status.totalBytes ?? status.size
  return total ? progressText(received, total) : formatBytes(received)
}

/**
 * Settings → About → Updates: the row's description. The last check's outcome, or what is
 * happening now.
 */
export function checkedLine(status: UpdateStatus, nowMs: number): string {
  switch (status.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'none':
      return status.checkedAt
        ? `You're up to date · checked ${relativeTime(status.checkedAt, nowMs)}`
        : "You're up to date"
    case 'available':
      return `${named(status)} is available.`
    case 'downloading':
      return `Downloading ${named(status)} · ${downloadProgress(status)}`
    case 'ready':
      return `${named(status)} is downloaded. Restart Kimochi to finish updating.`
    case 'installing':
      return `Installing ${named(status)}… Kimochi restarts when this is done.`
    case 'failed':
      return status.stage === 'check'
        ? `Could not check for updates${status.message ? `: ${status.message}` : '.'}`
        : status.stage === 'install'
          ? `Could not install the update${status.message ? `: ${status.message}` : '.'}`
          : `Download failed${status.message ? `: ${status.message}` : '.'}`
    case 'idle':
      return status.automatic
        ? 'Kimochi checks for updates on its own and asks before installing one.'
        : 'This development build does not check on its own.'
  }
}

/** The buttons that make sense now, in display order. */
export function updateActions(status: UpdateStatus): UpdateAction[] {
  switch (status.state) {
    case 'idle':
    case 'none':
      return ['check']
    case 'checking':
    case 'installing':
      return []
    case 'available':
      return ['download']
    case 'downloading':
      return ['cancel']
    case 'ready':
      return ['install']
    case 'failed':
      return status.stage === 'check' ? ['check'] : ['retry']
  }
}

/** A button's label; Download carries the size when it is known. */
export function actionLabel(action: UpdateAction, status: UpdateStatus): string {
  switch (action) {
    case 'check':
      return 'Check for updates'
    case 'download':
      return status.size ? `Download (${formatBytes(status.size)})` : 'Download'
    case 'cancel':
      return 'Cancel'
    case 'install':
      return 'Restart to update'
    case 'retry':
      return 'Retry'
    case 'dismiss':
      return 'Not now'
  }
}

/** Whether the action is the surface's primary one (the next step), rather than a way out. */
export const isPrimaryAction = (action: UpdateAction): boolean =>
  action === 'download' || action === 'install' || action === 'retry'

/** Whether the bar has anything to say: only while bytes arrive or the swap is under way. */
export const showsBar = (status: UpdateStatus): boolean =>
  status.state === 'downloading' || status.state === 'installing'

/** How full the bar is, 0–100: the bytes so far, full once downloaded. */
export function barPercent(status: UpdateStatus): number {
  switch (status.state) {
    case 'downloading': {
      const total = status.totalBytes ?? status.size
      return total ? percent(status.receivedBytes ?? 0, total) : 0
    }
    case 'ready':
    case 'installing':
      return 100
    default:
      return 0
  }
}

/** No measurable progress: the swap, or a download whose size the server did not say. */
export const isIndeterminate = (status: UpdateStatus): boolean =>
  status.state === 'installing' ||
  (status.state === 'downloading' && !(status.totalBytes ?? status.size))

/** The GitHub release page of the offered version, for "What's new". */
export const releaseUrl = (repository: string, status: UpdateStatus): string | null =>
  status.version ? `https://github.com/${repository}/releases/tag/v${status.version}` : null
