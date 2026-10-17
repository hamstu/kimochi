/**
 * Sync as the webviews see it (`sync_status`, the `sync-status` and `sync-log` events from
 * `src-tauri/src/sync.rs`), and the pure wording Settings → Account and the sync log window use.
 */

export type SyncState = 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out'

/** The losing side of a concurrent edit, kept so it can be restored (`sync_core::conflict_copy`). */
export interface SyncConflict {
  id: string
  collection: string
  recordId: string
  data: unknown
  hlc: string
  deviceId: string
  winnerHlc: string
  detectedAt: number
}

export interface SyncStatus {
  state: SyncState
  /** The active account's profile key; null when no account is in use. */
  account: string | null
  lastSyncAt: number | null
  /** Changes made here that the server has not accepted yet. */
  pending: number
  /** How the profile started on this computer: `copied-local`, `server` or `empty`. */
  origin: string | null
  lastError: string | null
  used: number | null
  limit: number | null
  conflicts: SyncConflict[]
  deviceId: string
}

export interface SyncLogEntry {
  /** Epoch milliseconds. */
  t: number
  kind: string
  text: string
}

export const SYNC_OFF: SyncStatus = {
  state: 'off',
  account: null,
  lastSyncAt: null,
  pending: 0,
  origin: null,
  lastError: null,
  used: null,
  limit: null,
  conflicts: [],
  deviceId: ''
}

const STATES: SyncState[] = ['off', 'idle', 'syncing', 'offline', 'error', 'signed-out']

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export function normalizeSyncStatus(raw: unknown): SyncStatus {
  if (!raw || typeof raw !== 'object') return SYNC_OFF
  const value = raw as Record<string, unknown>
  const state = STATES.includes(value.state as SyncState) ? (value.state as SyncState) : 'off'
  const conflicts = Array.isArray(value.conflicts)
    ? value.conflicts.flatMap((c): SyncConflict[] => {
        if (!c || typeof c !== 'object') return []
        const v = c as Record<string, unknown>
        if (typeof v.id !== 'string') return []
        return [
          {
            id: v.id,
            collection: text(v.collection) ?? '',
            recordId: text(v.recordId) ?? '',
            data: v.data ?? null,
            hlc: text(v.hlc) ?? '',
            deviceId: text(v.deviceId) ?? '',
            winnerHlc: text(v.winnerHlc) ?? '',
            detectedAt: num(v.detectedAt) ?? 0
          }
        ]
      })
    : []
  return {
    state,
    account: text(value.account),
    lastSyncAt: num(value.lastSyncAt),
    pending: num(value.pending) ?? 0,
    origin: text(value.origin),
    lastError: text(value.lastError),
    used: num(value.used),
    limit: num(value.limit),
    conflicts,
    deviceId: text(value.deviceId) ?? ''
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Synced 5 minutes ago" / "Not synced yet". */
export function lastSyncLine(at: number | null | undefined, now: number): string {
  if (!at) return 'Not synced yet.'
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'Synced just now.'
  if (minutes < 60) return `Synced ${minutes} minute${minutes === 1 ? '' : 's'} ago.`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Synced ${hours} hour${hours === 1 ? '' : 's'} ago.`
  const date = new Date(at)
  return `Synced on ${MONTHS[date.getMonth()]} ${date.getDate()}.`
}

/** The status line under "Sync now". */
export function syncStateLine(status: SyncStatus, now: number): string {
  const pending = status.pending > 0 ? ` ${status.pending} change${status.pending === 1 ? '' : 's'} waiting to sync.` : ''
  switch (status.state) {
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return `Offline: everything stays on this computer and syncs when Kimochi cloud can be reached.${pending}`
    case 'signed-out':
      return 'Sign in again to keep this account in sync.'
    case 'error':
      return `${lastSyncLine(status.lastSyncAt, now)}${pending}`
    case 'off':
      return 'Sign in to sync with your other computers.'
    default:
      return `${lastSyncLine(status.lastSyncAt, now)}${pending}`
  }
}

const COLLECTION_LABELS: Record<string, string> = {
  prefs: 'Setting',
  sessions: 'Session',
  lines: 'Line',
  notebook: 'Notebook entry',
  presets: 'Preset'
}

function clip(value: string, max = 80): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** "Session “Persona 5”", "Line “猫が…”", "Setting appearance", for the conflicts list. */
export function conflictTitle(conflict: SyncConflict): string {
  const label = COLLECTION_LABELS[conflict.collection] ?? conflict.collection
  const data = (conflict.data ?? {}) as Record<string, unknown>
  switch (conflict.collection) {
    case 'sessions':
      return `${label} “${clip(String(data.name ?? ''))}”`
    case 'lines':
      return `${label} “${clip(String(data.text ?? ''), 40)}”`
    case 'notebook': {
      const entry = (data.entry ?? {}) as Record<string, unknown>
      const name = [entry.family, entry.given].filter(Boolean).join(' ') || String(entry.name ?? '')
      return `${label} “${clip(name || '(unnamed)')}”`
    }
    case 'presets':
      return `${label} “${clip(conflict.recordId)}”`
    case 'prefs':
      return `${label} ${conflict.recordId.split('/').join('.')}`
    default:
      return `${label} ${conflict.recordId}`
  }
}

/** What the kept version says, briefly. */
export function conflictDetail(conflict: SyncConflict): string {
  const data = conflict.data as Record<string, unknown> | null
  if (conflict.collection === 'prefs') return `Kept value: ${clip(JSON.stringify(conflict.data), 120)}`
  if (conflict.collection === 'sessions' && data) return `Kept name: “${clip(String(data.name ?? ''))}”`
  if (conflict.collection === 'lines' && data) return `Kept text: “${clip(String(data.text ?? ''), 120)}”`
  return 'The version that lost, kept so you can bring it back.'
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** "2026-10-17 14:03:22.120" in local time. */
export function logTime(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** One log line as shown and copied: time, kind, text. */
export function logLine(entry: SyncLogEntry): string {
  return `${logTime(entry.t)}  ${entry.kind.padEnd(8)} ${entry.text}`
}

export function logText(entries: SyncLogEntry[]): string {
  return entries.map(logLine).join('\n')
}

/** Keep the newest `max` entries (the window's own bound, matching native's). */
export function appendLog(entries: SyncLogEntry[], entry: SyncLogEntry, max = 2000): SyncLogEntry[] {
  const next = entries.length >= max ? entries.slice(entries.length - max + 1) : entries.slice()
  next.push(entry)
  return next
}
