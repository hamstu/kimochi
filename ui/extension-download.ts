/**
 * On-demand dictionary engines, as the UI sees them: the `extension_status` reply and
 * `extension-download` event payload (`ExtensionStatus` in `src-tauri/src/extension_store.rs`), and
 * the wording Settings → Dictionary and onboarding share. The progress block, its bar, its line
 * and its buttons are the OCR models' (`model-download.ts`), which take any `DownloadStatus`.
 */
import { formatBytes, percent, progressText, type DownloadStatus, type ModelAction, type ModelState } from './model-download.js'
import type { DictionaryEngine } from './settings.js'

export type ExtensionEngine = 'yomitan' | 'hachidori' | 'tenten'
export const EXTENSION_ENGINES: readonly ExtensionEngine[] = ['yomitan', 'hachidori', 'tenten']

/**
 * An app update moved the engine's pin: the new release downloads in the background while the
 * earlier one (`from`) stays in use, so the status around it says `ready`.
 */
export interface ExtensionUpdate {
  /** The release in use until the update is installed. */
  from: string
  /** `absent`: not started, or waiting for the user after repeated failures. */
  state: Exclude<ModelState, 'ready'>
  file: string | null
  receivedBytes: number | null
  totalBytes: number | null
  overallReceived: number
  overallTotal: number
  message: string | null
  /** When a failed update is tried again this session (Unix seconds), if it will be. */
  retryAt: number | null
}

export interface ExtensionStatus extends DownloadStatus {
  engine: ExtensionEngine
  /** The pinned upstream release (an update's target). */
  version: string
  /** Where a ready engine is served from: its download, or (a debug build) the developer cache. */
  source: 'downloaded' | 'development' | null
  /** Its background update, when an earlier release is in use. */
  update: ExtensionUpdate | null
}

const STATES: readonly ModelState[] = ['absent', 'downloading', 'paused', 'failed', 'verifying', 'ready']

export const isExtensionEngine = (engine: unknown): engine is ExtensionEngine =>
  typeof engine === 'string' && (EXTENSION_ENGINES as readonly string[]).includes(engine)

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

function normalizeUpdate(raw: unknown): ExtensionUpdate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.from !== 'string' || r.state === 'ready' || !STATES.includes(r.state as ModelState)) return null
  return {
    from: r.from,
    state: r.state as ExtensionUpdate['state'],
    file: typeof r.file === 'string' ? r.file : null,
    receivedBytes: count(r.receivedBytes),
    totalBytes: count(r.totalBytes),
    overallReceived: count(r.overallReceived) ?? 0,
    overallTotal: count(r.overallTotal) ?? 0,
    message: typeof r.message === 'string' ? r.message : null,
    retryAt: count(r.retryAt)
  }
}

/**
 * The download an engine needs: its own, or none for the Yomitan API, which looks words up through
 * the browser's Yomitan.
 */
export function downloadEngineFor(engine: DictionaryEngine): ExtensionEngine | null {
  return engine === 'custom-api' ? null : engine
}

/** A native payload as an `ExtensionStatus`, or null when it is not one. */
export function normalizeExtensionStatus(raw: unknown): ExtensionStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isExtensionEngine(r.engine) || !STATES.includes(r.state as ModelState)) return null
  return {
    engine: r.engine,
    name: typeof r.name === 'string' ? r.name : r.engine,
    version: typeof r.version === 'string' ? r.version : '',
    state: r.state as ModelState,
    source: r.source === 'downloaded' || r.source === 'development' ? r.source : null,
    file: typeof r.file === 'string' ? r.file : null,
    receivedBytes: count(r.receivedBytes),
    totalBytes: count(r.totalBytes),
    overallReceived: count(r.overallReceived) ?? 0,
    overallTotal: count(r.overallTotal) ?? 0,
    message: typeof r.message === 'string' ? r.message : null,
    update: normalizeUpdate(r.update)
  }
}

/**
 * An engine's update as a download, for the progress block (`ModelDownload`): its bar and buttons
 * run on the same commands as a first download. Null when nothing is being updated.
 */
export function updateDownload(status: ExtensionStatus | null): DownloadStatus | null {
  const update = status?.update
  if (!status || !update) return null
  return {
    name: `${status.name} ${status.version}`,
    state: update.state,
    source: null,
    file: update.file,
    receivedBytes: update.receivedBytes,
    totalBytes: update.totalBytes,
    overallReceived: update.overallReceived,
    overallTotal: update.overallTotal,
    message: update.message
  }
}

/**
 * The update's line, e.g. "Updating to 26.10.22.0 · 3.2 MB of 15 MB", always saying which release
 * is in use meanwhile when it matters (paused, failed).
 */
export function updateLine(status: ExtensionStatus): string {
  const update = status.update
  if (!update) return ''
  const to = status.version
  const pct = percent(update.overallReceived, update.overallTotal)
  const using = `Using ${update.from} until then`
  switch (update.state) {
    case 'downloading':
      return `Updating to ${to} · ${progressText(update.overallReceived, update.overallTotal)}`
    case 'verifying':
      return `Verifying ${to}…`
    case 'paused':
      return `Update to ${to} paused${pct > 0 ? ` at ${pct}%` : ''}. ${using}.`
    case 'failed':
      return `Update to ${to} failed${update.message ? `: ${update.message}` : ''}. ${using}${
        update.retryAt !== null ? '; Kimochi tries again later.' : '.'
      }`
    case 'absent':
      return `Update to ${to} available · ${formatBytes(update.overallTotal)}. ${using}.`
  }
}

/**
 * The update's buttons. No Cancel: the earlier release is kept either way, and the update would
 * only come back on the next launch; pausing is the way to hold it.
 */
export function updateActions(status: ExtensionStatus): ModelAction[] {
  switch (status.update?.state) {
    case 'absent':
      return ['download']
    case 'downloading':
      return ['pause']
    case 'paused':
      return ['resume']
    case 'failed':
      return ['retry']
    default:
      return []
  }
}

/** "Download · 15 MB", the chooser's button for an engine that is not downloaded. */
export function downloadButtonLabel(status: ExtensionStatus | null): string {
  return status && status.overallTotal > 0 ? `Download · ${formatBytes(status.overallTotal)}` : 'Download'
}

/** The confirmation before a download: what, how big, from where, and that nothing changes yet. */
export function extensionDownloadPrompt(status: ExtensionStatus): { title: string; description: string } {
  const size = status.overallTotal > 0 ? `${formatBytes(status.overallTotal)} ` : ''
  return {
    title: `Download ${status.name}?`,
    description: `Kimochi downloads ${status.name} ${status.version}, ${size}from its official release on github.com, checks every file, and keeps it on this computer. Your current dictionary stays in use until the download is ready.`
  }
}

/** Whether "Remove downloaded engine…" is offered: only what the store downloaded. */
export const canRemoveExtension = (status: ExtensionStatus | null): boolean =>
  status?.state === 'ready' && status.source === 'downloaded'

/** The remove confirmation: the code goes, the user's dictionaries and settings stay. */
export function removePrompt(status: ExtensionStatus): { title: string; description: string } {
  return {
    title: `Remove ${status.name}?`,
    description: `This frees ${formatBytes(status.overallTotal)} of program files. The dictionaries you imported into ${status.name} and its settings are kept, so downloading it again later brings them back.`
  }
}

/** Whether an engine can be used now (downloaded, or the developer cache in a debug build). */
export const isEngineReady = (status: ExtensionStatus | null): boolean => status?.state === 'ready'
