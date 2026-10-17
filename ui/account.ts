/**
 * Kimochi accounts as the webviews see them (`account_status`, the `account-changed`,
 * `account-link` and `account-backup` events from `src-tauri/src/account.rs`), and the pure
 * decisions the panels make from them. The token never reaches a webview: only the cached user,
 * usage and backup state do.
 */

export type Plan = 'free' | 'plus' | 'owner'

export interface AccountUser {
  id: string
  email: string | null
  emailVerified?: boolean
  displayName: string | null
  avatarUrl?: string | null
  plan: Plan
  status: 'active' | 'suspended'
}

export type UsageMetric = 'ocr' | 'translate' | 'tts' | 'explain' | 'storage'

export interface Usage {
  plan: Plan
  period: { start: string; end: string }
  metrics: Partial<Record<UsageMetric, { used: number; limit: number | null }>>
}

export interface AccountStatus {
  signedIn: boolean
  user?: AccountUser | null
  usage?: Usage | null
  /** A sign-in waiting for the browser: the code to show and where to confirm it. */
  linking?: { code: string; verifyUrl: string; expiresAt: number } | null
  /**
   * The server this account belongs to (each has its own sign-in): `forced` when a development
   * build's `KIMOCHI_SERVER` picks it over `serverSettings.mode`.
   */
  server?: AccountServer | null
  backup?: { running: boolean; lastBackupAt?: number | null; lastError?: string | null }
}

export interface AccountServer {
  mode: 'cloud' | 'local'
  url: string
  forced: boolean
}

export type LinkStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'error'

export interface LinkEvent {
  status: LinkStatus
  code: string
  message?: string | null
}

export interface BackupEvent {
  phase: 'scanning' | 'uploading' | 'downloading' | 'restarting' | 'done' | 'error'
  done: number
  total: number
  error?: string | null
}

/** `accountBackup` in settings.json: what the automatic backup and Back up now include. */
export interface BackupOptions {
  prefs: boolean
  sessions: boolean
}

export const DEFAULT_BACKUP_OPTIONS: BackupOptions = { prefs: false, sessions: false }

export const SIGNED_OUT: AccountStatus = { signedIn: false, backup: { running: false } }

/** Accept whatever native sent; anything unexpected reads as signed out. */
export function normalizeStatus(raw: unknown): AccountStatus {
  if (!raw || typeof raw !== 'object') return SIGNED_OUT
  const value = raw as Partial<AccountStatus>
  return {
    signedIn: value.signedIn === true,
    user: value.user ?? null,
    usage: value.usage ?? null,
    linking: value.linking ?? null,
    server: normalizeServer(value.server),
    backup: value.backup ?? { running: false }
  }
}

function normalizeServer(raw: unknown): AccountServer | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<AccountServer>
  if (value.mode !== 'cloud' && value.mode !== 'local') return null
  return { mode: value.mode, url: typeof value.url === 'string' ? value.url : '', forced: value.forced === true }
}

// ---------------------------------------------------------------- translation

/** Settings → Translation & AI: who translates a line. `auto` is Kimochi cloud when signed in. */
export type TranslationProvider = 'auto' | 'deepl' | 'kimochi'

/** The service a translation goes to, or null when neither is usable. */
export function translationRoute(
  provider: TranslationProvider | undefined,
  deeplKey: string,
  signedIn: boolean
): 'deepl' | 'kimochi' | null {
  const hasKey = deeplKey.trim().length > 0
  switch (provider) {
    case 'deepl':
      return hasKey ? 'deepl' : null
    case 'kimochi':
      return signedIn ? 'kimochi' : null
    default:
      return signedIn ? 'kimochi' : hasKey ? 'deepl' : null
  }
}

/** Whether Translate is offered in the Log: the chosen provider can be used right now. */
export const translationAvailable = (
  provider: TranslationProvider | undefined,
  deeplKey: string,
  signedIn: boolean
): boolean => translationRoute(provider, deeplKey, signedIn) !== null

// ---------------------------------------------------------------- usage

const METRIC_LABELS: Record<UsageMetric, { label: string; unit: string }> = {
  ocr: { label: 'Cloud OCR', unit: 'scans' },
  tts: { label: 'Read aloud', unit: 'read-alouds' },
  translate: { label: 'Translation', unit: 'translations' },
  explain: { label: 'Explanations', unit: 'explanations' },
  storage: { label: 'Backup storage', unit: '' }
}

export const PLAN_LABELS: Record<Plan, string> = { free: 'Free', plus: 'Plus', owner: 'Owner' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Nov 1" from an ISO date, in UTC (allowances reset at 00:00 UTC). */
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

export interface UsageRow {
  metric: UsageMetric
  label: string
  /** "120 of 500 scans", "Unlimited", "12 MB of 250 MB". */
  amount: string
  /** 0–1, or null when unlimited. */
  fraction: number | null
  /** At or over the allowance. */
  exhausted: boolean
}

/** The usage meters, in the order Settings → Account shows them. */
export function usageRows(usage: Usage | null | undefined): UsageRow[] {
  if (!usage) return []
  const order: UsageMetric[] = ['ocr', 'tts', 'translate', 'explain', 'storage']
  return order.flatMap((metric): UsageRow[] => {
    const value = usage.metrics?.[metric]
    if (!value) return []
    const { label, unit } = METRIC_LABELS[metric]
    const bytes = metric === 'storage'
    const used = bytes ? formatBytes(value.used) : value.used.toLocaleString('en-US')
    if (value.limit === null || value.limit === undefined) {
      return [{ metric, label, amount: `${used} used · unlimited`, fraction: null, exhausted: false }]
    }
    const limit = bytes ? formatBytes(value.limit) : value.limit.toLocaleString('en-US')
    const fraction = value.limit > 0 ? Math.min(1, value.used / value.limit) : 1
    return [
      {
        metric,
        label,
        amount: `${used} of ${limit}${unit ? ` ${unit}` : ''}`,
        fraction,
        exhausted: value.used >= value.limit
      }
    ]
  })
}

/** "Resets on Nov 1" for the monthly allowances. */
export function resetLine(usage: Usage | null | undefined): string | null {
  const date = shortDate(usage?.period?.end)
  return date ? `Monthly allowances reset on ${date}.` : null
}

/** "Backed up 5 minutes ago" / "Not backed up yet". */
export function lastBackupLine(at: number | null | undefined, now: number): string {
  if (!at) return 'Not backed up yet.'
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'Backed up just now.'
  if (minutes < 60) return `Backed up ${minutes} minute${minutes === 1 ? '' : 's'} ago.`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Backed up ${hours} hour${hours === 1 ? '' : 's'} ago.`
  const date = new Date(at)
  return `Backed up on ${MONTHS[date.getMonth()]} ${date.getDate()}.`
}

/** The progress line while a backup or restore runs. */
export function backupProgressLine(event: BackupEvent | null): string | null {
  if (!event) return null
  switch (event.phase) {
    case 'scanning':
      return 'Checking what changed…'
    case 'uploading':
      return event.total > 0 ? `Uploading ${event.done} of ${event.total}…` : 'Uploading…'
    case 'downloading':
      return event.total > 0 ? `Downloading ${event.done} of ${event.total}…` : 'Downloading…'
    case 'restarting':
      return 'Restarting Kimochi…'
    case 'done':
      return null
    case 'error':
      return null
  }
}

/** What the person signed in is called on the Account page. */
export function accountName(user: AccountUser | null | undefined): string {
  return user?.displayName?.trim() || user?.email || 'Kimochi account'
}

/** The sidebar's account bar: the name over the email, or the email alone when there is no name. */
export function accountLines(user: AccountUser | null | undefined): { primary: string; secondary: string | null } {
  const name = user?.displayName?.trim() || null
  const email = user?.email?.trim() || null
  if (name) return { primary: name, secondary: email && email !== name ? email : null }
  return { primary: email ?? 'Kimochi account', secondary: null }
}

/** The letter in the avatar circle when the account has no picture. */
export function accountInitial(user: AccountUser | null | undefined): string {
  const first = Array.from(accountName(user).trim())[0] ?? 'K'
  return first.toLocaleUpperCase()
}
