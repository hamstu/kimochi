/**
 * DEV-ONLY: the Kimochi account and Sync commands for the browser preview (`preview-setup.ts`),
 * with a simulated sign-in, account switcher and Sync that emit `account-changed`, `account-link`,
 * `sync-status` and `sync-log` like `src-tauri/src/account.rs` and `sync.rs`.
 *
 *   ?account=signedout|linking|signedin|full|suspended|multi|local   the starting state (default:
 *               signedout). `multi` has a second account (on the local server) not in use;
 *               `local` has an account on this computer but uses the Local profile. Signed in
 *               (`signedin`, `full`, `suspended`, `multi`), the foot of the sidebar is the account
 *               switcher (avatar and name, Settings in its menu); otherwise it is the Settings row.
 *               Add `&update=available` to see the update notice above it.
 *   ?server=cloud|local|forced   the server new sign-ins go to (development builds' switch in
 *               Settings → Account; `forced` is local pinned by KIMOCHI_SERVER). Default: cloud.
 *   ?sync=idle|offline|error|conflicts   Sync's state while signed in (default: idle).
 *   ?avatar=1   the account has a picture; without it the switcher shows the name's first letter.
 *   ?name=0     the account has no display name (the switcher shows the email before "@").
 *   ?name=long  a display name too long for the sidebar (it ends in an ellipsis).
 *
 * `full` is signed in with this month's scans used up and sync storage nearly full; `suspended` is
 * a suspended account. Signing in from `signedout` shows the code, and the "browser" approves it
 * after six seconds. A switch in the preview does not reload the windows.
 */
import { emit } from '@tauri-apps/api/event'
import type { AccountServer, AccountStatus, AccountSummary, AccountUser, Usage } from '@ui/account'
import type { SyncLogEntry, SyncStatus } from '@ui/sync'

const params = new URLSearchParams(location.search)
const seed = params.get('account') ?? 'signedout'
const serverSeed = params.get('server') ?? 'cloud'
const syncSeed = params.get('sync') ?? 'idle'

const SERVER_URL = { cloud: 'https://kimochiapp.com', local: 'http://localhost:3000' }
const serverFor = (mode: 'cloud' | 'local', forced = false): AccountServer => ({ mode, url: SERVER_URL[mode], forced })
let linkServer = serverFor(serverSeed === 'cloud' ? 'cloud' : 'local', serverSeed === 'forced')

/** Whether the preview starts signed in, so Kimochi cloud features show (`cloudAccess`). */
export const PREVIEW_SIGNED_IN = ['signedin', 'full', 'suspended', 'multi'].includes(seed)

function usage(full: boolean): Usage {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return {
    plan: 'free',
    period: { start: start.toISOString(), end: end.toISOString() },
    metrics: {
      ocr: { used: full ? 500 : 132, limit: 500 },
      translate: { used: full ? 214 : 41, limit: 300 },
      tts: { used: full ? 93 : 12, limit: 100 },
      explain: { used: full ? 30 : 4, limit: 30 },
      storage: { used: full ? 241_000_000 : 18_400_000, limit: 250_000_000 }
    }
  }
}

/** A stand-in profile picture, drawn here so the preview needs no network. */
const PREVIEW_AVATAR = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6a87a"/><stop offset="1" stop-color="#c2527a"/></linearGradient></defs><rect width="48" height="48" fill="url(#g)"/><circle cx="24" cy="19" r="8" fill="#fff" opacity=".9"/><path d="M8 46c2-10 9-15 16-15s14 5 16 15z" fill="#fff" opacity=".9"/></svg>'
)}`

const USER: AccountUser = {
  id: 'usr_preview',
  email: 'reader@example.com',
  emailVerified: true,
  displayName:
    params.get('name') === '0' ? null : params.get('name') === 'long' ? 'Hamish Macpherson-Featherstonehaugh' : 'Hamish',
  avatarUrl: params.get('avatar') === '1' ? PREVIEW_AVATAR : null,
  plan: 'free',
  status: seed === 'suspended' ? 'suspended' : 'active'
}
const OTHER: AccountUser = {
  id: 'usr_tester',
  email: 'e2e-test@example.com',
  emailVerified: true,
  displayName: null,
  avatarUrl: null,
  plan: 'free',
  status: 'active'
}

const summary = (user: AccountUser, mode: 'cloud' | 'local', active: boolean): AccountSummary => ({
  key: `${mode}-${user.id}`,
  user,
  server: serverFor(mode),
  signedIn: true,
  active,
  available: true
})

let accounts: AccountSummary[] = (() => {
  switch (seed) {
    case 'signedin':
    case 'full':
    case 'suspended':
      return [summary(USER, 'cloud', true)]
    case 'multi':
      return [summary(USER, 'cloud', true), summary(OTHER, 'local', false)]
    case 'local':
      return [summary(USER, 'cloud', false)]
    default:
      return []
  }
})()
let linking: AccountStatus['linking'] =
  seed === 'linking'
    ? { code: 'K7QM-3XPA', verifyUrl: 'http://127.0.0.1:1450/link?code=K7QM-3XPA', expiresAt: Date.now() + 600_000 }
    : null

function status(): AccountStatus {
  const active = accounts.find((a) => a.active) ?? null
  return {
    signedIn: Boolean(active?.signedIn),
    user: active?.user ?? null,
    usage: active ? usage(seed === 'full') : null,
    linking,
    server: active?.server ?? linkServer,
    linkServer,
    accounts,
    profile: { key: active?.key ?? null, root: active ? `profiles/${active.key}` : '', needsSignIn: Boolean(active && !active.signedIn) },
    switching: false
  }
}

function publish(): AccountStatus {
  const next = status()
  void emit('account-changed', next)
  publishSync()
  return next
}

// ---------------------------------------------------------------- Sync

const now = Date.now()
const LOG: SyncLogEntry[] = [
  { t: now - 3_600_000, kind: 'profile', text: 'First sign-in to reader@example.com here and the account has nothing synced yet: copied this computer\'s Local profile (214 files) into it. The Local profile is unchanged.' },
  { t: now - 3_599_000, kind: 'info', text: 'Synced: 0 change(s) received, 0 applied here, 1893 sent' },
  { t: now - 1_800_000, kind: 'net', text: 'Offline: changes are kept here and sync once Kimochi cloud can be reached' },
  { t: now - 1_500_000, kind: 'net', text: 'Back online' },
  { t: now - 1_499_000, kind: 'pull', text: 'Deleted line s1/l4f0c2e9a17b3d5c8 (deleted on another computer)' },
  { t: now - 1_498_000, kind: 'conflict', text: 'session 8a3c… changed on two computers; kept the other computer\'s version, the other is in Conflicts' },
  { t: now - 1_497_000, kind: 'info', text: 'Synced: 12 change(s) received, 11 applied here, 4 sent, 1 conflict(s) kept' },
  { t: now - 420_000, kind: 'info', text: 'Synced: 3 change(s) received, 3 applied here, 0 sent' }
]

let syncState: SyncStatus = {
  state: syncSeed === 'offline' ? 'offline' : syncSeed === 'error' ? 'error' : 'idle',
  account: null,
  lastSyncAt: now - 7 * 60_000,
  pending: syncSeed === 'offline' ? 6 : 0,
  origin: 'copied-local',
  lastError: syncSeed === 'error' ? 'Your Kimochi sync storage is full (250 MB). Sync is paused until you free space under Manage account on the web; everything stays on this computer.' : null,
  used: seed === 'full' ? 241_000_000 : 18_400_000,
  limit: 250_000_000,
  conflicts:
    syncSeed === 'conflicts'
      ? [
          {
            id: 'sessions/8a3c@0001760000000000.00000.dA',
            collection: 'sessions',
            recordId: '8a3c',
            data: { name: 'Persona 5 (laptop)', description: '', createdAt: 1, updatedAt: 2 },
            hlc: '0001760000000000.00000.dA',
            deviceId: 'dA',
            winnerHlc: '0001760000060000.00000.dB',
            detectedAt: now - 1_498_000
          },
          {
            id: 'lines/8a3c/u1@0001760000000000.00001.dA',
            collection: 'lines',
            recordId: '8a3c/u1',
            data: { text: '今日はいい天気ですね。', source: 'ocr', ts: 1 },
            hlc: '0001760000000000.00001.dA',
            deviceId: 'dA',
            winnerHlc: '0001760000090000.00000.dB',
            detectedAt: now - 1_200_000
          }
        ]
      : [],
  deviceId: 'dpreview'
}

function syncStatus(): SyncStatus {
  const active = accounts.find((a) => a.active)
  return active ? { ...syncState, account: active.key } : { ...syncState, state: 'off', account: null, conflicts: [] }
}

function publishSync(): SyncStatus {
  const next = syncStatus()
  void emit('sync-status', next)
  return next
}

function log(kind: string, text: string): void {
  const entry = { t: Date.now(), kind, text }
  LOG.push(entry)
  void emit('sync-log', entry)
}

let linkTimer: ReturnType<typeof setTimeout> | null = null
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Handler = (args: Record<string, unknown> | undefined) => unknown

export const ACCOUNT_HANDLERS: Record<string, Handler> = {
  account_status: () => status(),
  profile_current: () => ({ key: accounts.find((a) => a.active)?.key ?? null, root: '' }),
  account_set_server: (args) => {
    const mode = args?.mode === 'local' ? 'local' : 'cloud'
    if (linkServer.forced) throw 'invalid: KIMOCHI_SERVER=local picks the server for this run; unset it to switch here'
    linkServer = serverFor(mode)
    return publish()
  },
  account_link_start: () => {
    const code = 'K7QM-3XPA'
    const verifyUrl = `http://127.0.0.1:1450/link?code=${code}`
    linking = { code, verifyUrl, expiresAt: Date.now() + 600_000 }
    publish()
    void emit('account-link', { status: 'pending', code })
    console.info('[preview] account_link_start: the browser would open', verifyUrl)
    if (linkTimer) clearTimeout(linkTimer)
    linkTimer = setTimeout(() => {
      void emit('account-link', { status: 'approved', code })
      linking = null
      const mode = linkServer.mode
      const user = accounts.some((a) => a.user?.id === USER.id && a.server?.mode === mode) ? OTHER : USER
      const key = `${mode}-${user.id}`
      accounts = [summary(user, mode, true), ...accounts.filter((a) => a.key !== key).map((a) => ({ ...a, active: false }))]
      log('profile', `Switched to ${user.email}`)
      publish()
    }, 6000)
    return { code, verifyUrl, expiresIn: 600 }
  },
  account_link_cancel: () => {
    if (linkTimer) clearTimeout(linkTimer)
    void emit('account-link', { status: 'cancelled', code: linking?.code ?? '' })
    linking = null
    return publish()
  },
  account_link_open: () => console.info('[preview] account_link_open'),
  account_switch: async (args) => {
    const key = typeof args?.key === 'string' ? args.key : null
    await wait(400)
    accounts = accounts.map((a) => ({ ...a, active: a.key === key }))
    log('profile', `Switched to ${accounts.find((a) => a.active)?.user?.email ?? 'Local (no account)'}`)
    return publish()
  },
  account_sign_out: (args) => {
    const key = typeof args?.key === 'string' ? args.key : accounts.find((a) => a.active)?.key
    accounts = accounts.map((a) => (a.key === key ? { ...a, signedIn: false, active: false } : a))
    return publish()
  },
  account_remove: (args) => {
    accounts = accounts.filter((a) => a.key !== args?.key)
    return publish()
  },
  account_refresh: () => status(),
  account_open_web: () => console.info('[preview] account_open_web: http://127.0.0.1:1450/account'),
  sync_status: () => syncStatus(),
  sync_now: () => {
    syncState = { ...syncState, state: 'syncing' }
    const reply = publishSync()
    setTimeout(() => {
      syncState = { ...syncState, state: syncSeed === 'offline' ? 'offline' : 'idle', lastSyncAt: Date.now() }
      log('info', 'Synced: 2 change(s) received, 2 applied here, 1 sent')
      publishSync()
    }, 900)
    return reply
  },
  sync_log: () => LOG.slice(),
  sync_log_clear: () => {
    LOG.length = 0
    void emit('sync-log-cleared', {})
  },
  sync_conflict_resolve: (args) => {
    syncState = { ...syncState, conflicts: syncState.conflicts.filter((c) => c.id !== args?.id) }
    log('merge', `${args?.action === 'restore' ? 'Restored the kept version of' : 'Dismissed conflict'} ${String(args?.id)}`)
    return publishSync()
  },
  sync_export: async () => {
    await wait(800)
    return 18_400_000
  },
  sync_local_changed: () => undefined,
  sync_hold_ready: () => undefined,
  cloud_translate: () => {
    if (!accounts.some((a) => a.active && a.signedIn))
      throw 'native: Kimochi cloud translation needs a Kimochi account. Sign in from Settings → Account, or use your own DeepL key in Settings → Translation & AI.'
    return '(Preview) Kimochi cloud translation would appear here.'
  }
}
