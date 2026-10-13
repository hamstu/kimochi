/**
 * On-demand dictionary engines, as the UI sees them: the `extension_status` reply and
 * `extension-download` event payload (`ExtensionStatus` in `src-tauri/src/extension_store.rs`), and
 * the wording Settings → Dictionary and onboarding share. The progress block, its bar, its line
 * and its buttons are the OCR models' (`model-download.ts`), which take any `DownloadStatus`.
 */
import { formatBytes, type DownloadStatus, type ModelState } from './model-download.js'
import type { DictionaryEngine } from './settings.js'

export type ExtensionEngine = 'yomitan' | 'hachidori' | 'tenten'
export const EXTENSION_ENGINES: readonly ExtensionEngine[] = ['yomitan', 'hachidori', 'tenten']

export interface ExtensionStatus extends DownloadStatus {
  engine: ExtensionEngine
  /** The pinned upstream release. */
  version: string
  /** Where a ready engine is served from: its download, or (a debug build) the developer cache. */
  source: 'downloaded' | 'development' | null
}

const STATES: readonly ModelState[] = ['absent', 'downloading', 'paused', 'failed', 'verifying', 'ready']

export const isExtensionEngine = (engine: unknown): engine is ExtensionEngine =>
  typeof engine === 'string' && (EXTENSION_ENGINES as readonly string[]).includes(engine)

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** The download an engine needs: its own, or Yomitan's for the Yomitan API (which runs over it). */
export function downloadEngineFor(engine: DictionaryEngine): ExtensionEngine {
  return engine === 'custom-api' ? 'yomitan' : engine
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
    message: typeof r.message === 'string' ? r.message : null
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
