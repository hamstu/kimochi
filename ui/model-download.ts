/**
 * On-demand model downloads (the local OCR engines', and sentence audio's speech model), as the
 * UI sees them: the `model_status` reply and
 * `model-download` event payload (`ModelStatus` in `src-tauri/src/model_store.rs`), and the
 * pure wording and decisions the settings card, the sidebar badge and the engine pickers share.
 */

/** The local OCR engines: an `ocrMode` value whose models are downloaded. */
export type OcrModelEngine = 'meikiocr' | 'mangaocr' | 'ppocr'
/** Every downloadable model: the OCR engines', and sentence audio's speech recogniser. */
export type ModelEngine = OcrModelEngine | 'sensevoice'
export type ModelState = 'absent' | 'downloading' | 'paused' | 'failed' | 'verifying' | 'ready'
export type ModelSource = 'downloaded' | 'bundled' | 'development'
export type ModelAction = 'download' | 'pause' | 'resume' | 'retry' | 'cancel' | 'delete'

/**
 * What the progress block, its wording and its buttons need from any download: an OCR model's
 * (`ModelStatus`) or a dictionary engine's (`ExtensionStatus`, ui/extension-download.ts).
 */
export interface DownloadStatus {
  name: string
  state: ModelState
  /** Where a ready download lives: downloaded, bundled or development. */
  source: string | null
  file: string | null
  receivedBytes: number | null
  totalBytes: number | null
  overallReceived: number
  overallTotal: number
  message: string | null
}

export interface ModelStatus extends DownloadStatus {
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

/** Whether an `ocrMode` value is a local OCR engine with downloaded models. */
export const isModelEngine = (mode: unknown): mode is OcrModelEngine =>
  mode === 'meikiocr' || mode === 'mangaocr' || mode === 'ppocr'

const isDownloadable = (engine: unknown): engine is ModelEngine =>
  isModelEngine(engine) || engine === 'sensevoice'

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** A native payload as a `ModelStatus`, or null when it is not one (an older backend, a mock). */
export function normalizeModelStatus(raw: unknown): ModelStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isDownloadable(r.engine) || !STATES.includes(r.state as ModelState)) return null
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

/** The line under the settings card's progress bar, e.g. "Downloading Manga OCR · 212 MB of 539 MB". */
export function statusLine(status: DownloadStatus): string {
  const pct = percent(status.overallReceived, status.overallTotal)
  switch (status.state) {
    case 'absent':
      return `Not downloaded · ${formatBytes(status.overallTotal)}`
    case 'downloading':
      return `Downloading ${status.name} · ${progressText(status.overallReceived, status.overallTotal)}`
    case 'verifying':
      return 'Verifying…'
    case 'paused':
      return pct > 0 ? `Paused at ${pct}%` : 'Paused'
    case 'failed':
      return status.message ? `Download failed: ${status.message}` : 'Download failed'
    case 'ready':
      return status.source === 'bundled'
        ? 'Ready · included with this build'
        : status.source === 'development'
          ? 'Ready · using the development copy'
          : `Ready · ${formatBytes(status.overallTotal)}`
  }
}

/**
 * Whether the bar has anything to say. Only while a download is under way (or stuck): an empty
 * bar before it starts and a full one for good afterwards are noise, so those states show the
 * status line alone.
 */
export function showsBar(status: DownloadStatus): boolean {
  return status.state !== 'absent' && status.state !== 'ready'
}

/** How full the progress bar is, 0–100: empty until something arrives, full once ready. */
export function barPercent(status: DownloadStatus): number {
  switch (status.state) {
    case 'absent':
      return 0
    case 'ready':
    case 'verifying':
      return 100
    default:
      return percent(status.overallReceived, status.overallTotal)
  }
}

/** A button's label; Download carries the size, since pressing it is the consent. */
export function actionLabel(action: ModelAction, status: DownloadStatus): string {
  switch (action) {
    case 'download':
      return status.overallTotal > 0 ? `Download (${formatBytes(status.overallTotal)})` : 'Download'
    case 'pause':
      return 'Pause'
    case 'resume':
      return 'Resume'
    case 'retry':
      return 'Retry'
    case 'cancel':
      return 'Cancel'
    case 'delete':
      return 'Delete'
  }
}

/**
 * Picking an engine in the sidebar or Settings: a local engine whose models were never
 * downloaded asks first (choosing it starts a download of hundreds of MB); anything else (a
 * ready model, or one already under way, paused or failed) is selected directly. `status` is the
 * picked engine's model status, null when it has none (a cloud engine, an older backend).
 */
export function engineChoice(mode: string, status: ModelStatus | null): 'confirm' | 'select' {
  return isModelEngine(mode) && status?.engine === mode && status.state === 'absent'
    ? 'confirm'
    : 'select'
}

/** The wording of the confirmation `engineChoice` asks for. */
export function downloadPrompt(status: ModelStatus): { title: string; description: string } {
  const size = status.overallTotal > 0 ? `about ${formatBytes(status.overallTotal)}` : 'large'
  return {
    title: `Download ${status.name}?`,
    description: `${status.name} needs its model, which is ${size}. It will be downloaded now and kept on this computer; scans with ${status.name} start once it finishes.`
  }
}

/** The buttons that make sense now, in display order. */
export function modelActions(status: DownloadStatus): ModelAction[] {
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

/**
 * The actions shown as buttons beside the bar: everything but Delete, which is a quiet item in
 * the engine panel's overflow menu rather than a button inviting a click.
 */
export const primaryModelActions = (status: DownloadStatus): ModelAction[] =>
  modelActions(status).filter((action) => action !== 'delete')

/** Whether "Remove downloaded model…" is offered: only a model the store downloaded. */
export const canRemoveModel = (status: ModelStatus | null): boolean =>
  status?.state === 'ready' && status.source === 'downloaded'

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
