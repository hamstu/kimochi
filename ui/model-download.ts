/**
 * On-demand OCR model downloads, as the UI sees them: the `model_status` reply and
 * `model-download` event payload (`ModelStatus` in `src-tauri/src/model_store.rs`), and the
 * pure wording and decisions the settings card and the sidebar badge share.
 */

export type ModelEngine = 'meikiocr' | 'mangaocr'
export type ModelState = 'absent' | 'downloading' | 'paused' | 'failed' | 'verifying' | 'ready'
export type ModelSource = 'downloaded' | 'bundled' | 'development'
export type ModelAction = 'download' | 'pause' | 'resume' | 'retry' | 'cancel' | 'delete'

export interface ModelStatus {
  engine: ModelEngine
  name: string
  state: ModelState
  /** Where ready models live. */
  source: ModelSource | null
  /** The file being downloaded or verified. */
  file: string | null
  receivedBytes: number | null
  totalBytes: number | null
  overallReceived: number
  overallTotal: number
  /** Why the download failed. */
  message: string | null
}

const STATES: readonly ModelState[] = [
  'absent',
  'downloading',
  'paused',
  'failed',
  'verifying',
  'ready'
]
const SOURCES: readonly ModelSource[] = ['downloaded', 'bundled', 'development']

export const isModelEngine = (mode: unknown): mode is ModelEngine =>
  mode === 'meikiocr' || mode === 'mangaocr'

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** A native payload as a `ModelStatus`, or null when it is not one (an older backend, a mock). */
export function normalizeModelStatus(raw: unknown): ModelStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isModelEngine(r.engine) || !STATES.includes(r.state as ModelState)) return null
  return {
    engine: r.engine,
    name: typeof r.name === 'string' ? r.name : r.engine,
    state: r.state as ModelState,
    source: SOURCES.includes(r.source as ModelSource) ? (r.source as ModelSource) : null,
    file: typeof r.file === 'string' ? r.file : null,
    receivedBytes: count(r.receivedBytes),
    totalBytes: count(r.totalBytes),
    overallReceived: count(r.overallReceived) ?? 0,
    overallTotal: count(r.overallTotal) ?? 0,
    message: typeof r.message === 'string' ? r.message : null
  }
}

/** Whole percent, rounded down (as native does) so 100% only ever means done. */
export function percent(received: number, total: number): number {
  if (!(total > 0)) return 0
  return Math.floor((Math.min(Math.max(received, 0), total) * 100) / total)
}

/** Decimal units, as file managers show them: 820 KB, 4.2 MB, 46 MB, 1.2 GB. */
export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return '0 MB'
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`
  if (bytes < 1e7) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

/** "12 MB of 46 MB". */
export const progressText = (received: number, total: number): string =>
  `${formatBytes(received)} of ${formatBytes(total)}`

/** One short line for the state, e.g. "Downloading… 32%". */
export function stateLabel(status: ModelStatus): string {
  const pct = percent(status.overallReceived, status.overallTotal)
  switch (status.state) {
    case 'absent':
      return 'Not downloaded'
    case 'downloading':
      return `Downloading… ${pct}%`
    case 'verifying':
      return 'Verifying…'
    case 'paused':
      return pct > 0 ? `Paused at ${pct}%` : 'Paused'
    case 'failed':
      return 'Download failed'
    case 'ready':
      return status.source === 'downloaded' || !status.source
        ? 'Downloaded'
        : status.source === 'bundled'
          ? 'Included with this build'
          : 'Using the development copy'
  }
}

/** The buttons that make sense now, in display order. */
export function modelActions(status: ModelStatus): ModelAction[] {
  switch (status.state) {
    case 'absent':
      return ['download']
    case 'downloading':
      return ['pause', 'cancel']
    case 'verifying':
      return ['cancel']
    case 'paused':
      return ['resume', 'cancel']
    case 'failed':
      return ['retry', 'cancel']
    case 'ready':
      // Only what the store downloaded can be deleted; bundled models belong to the app.
      return status.source === 'downloaded' ? ['delete'] : []
  }
}

/** Whether progress bars are shown. */
export const showsProgress = (status: ModelStatus): boolean =>
  status.state === 'downloading' ||
  status.state === 'verifying' ||
  ((status.state === 'paused' || status.state === 'failed') && status.overallReceived > 0)

/**
 * The sidebar badge: a spinner and percentage while busy, a warning when the selected engine
 * cannot scan until the user acts, nothing once ready.
 */
export function badgeKind(status: ModelStatus | null): 'progress' | 'warning' | null {
  if (!status) return null
  if (status.state === 'downloading' || status.state === 'verifying') return 'progress'
  if (status.state === 'ready') return null
  return 'warning'
}

/** The badge's tooltip and accessible name. */
export function badgeLabel(status: ModelStatus): string {
  switch (status.state) {
    case 'downloading':
      return `Downloading the ${status.name} model: ${progressText(status.overallReceived, status.overallTotal)}`
    case 'verifying':
      return `Verifying the ${status.name} model`
    case 'paused':
      return `The ${status.name} model download is paused. Open OCR settings to resume it.`
    case 'failed':
      return `The ${status.name} model download failed${status.message ? `: ${status.message}` : ''}. Open OCR settings to retry.`
    case 'absent':
      return `The ${status.name} model is not downloaded. Open OCR settings to download it.`
    case 'ready':
      return `The ${status.name} model is ready`
  }
}
