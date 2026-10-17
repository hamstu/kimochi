/**
 * DEV-ONLY: the Kimochi account commands for the browser preview (`preview-setup.ts`), with a
 * simulated sign-in, backup and restore that emit `account-changed`, `account-link` and
 * `account-backup` like `src-tauri/src/account.rs`.
 *
 *   ?account=signedout|linking|signedin|full|suspended   the starting state (default: signedout)
 *   ?server=cloud|local|forced   the server (development builds' switch in Settings → Account;
 *                                `forced` is local pinned by KIMOCHI_SERVER). Default: cloud.
 *
 * `full` is signed in with this month's scans used up and the backup storage nearly full;
 * `suspended` is a suspended account. Signing in from `signedout` shows the code, and the
 * "browser" approves it after six seconds. The restore cannot restart a browser tab: it ends in a
 * failure after the download, the one state no other seed reaches. Each server keeps its own
 * account, as in native: the seed is the starting server's, the other one starts signed out.
 */
import { emit } from '@tauri-apps/api/event'
import type { AccountServer, AccountStatus, Usage } from '@ui/account'

const params = new URLSearchParams(location.search)
const seed = params.get('account') ?? 'signedout'
const serverSeed = params.get('server') ?? 'cloud'

const SERVER_URL = { cloud: 'https://kimochi-server.hamish.workers.dev', local: 'http://localhost:3000' }
const serverFor = (mode: 'cloud' | 'local', forced = false): AccountServer => ({ mode, url: SERVER_URL[mode], forced })
let server = serverFor(serverSeed === 'cloud' ? 'cloud' : 'local', serverSeed === 'forced')
/** The other server's account while it is not the one in use. */
let parked: AccountStatus = { signedIn: false, linking: null, backup: { running: false } }

/** Whether the preview starts signed in, so Kimochi cloud features show (`cloudAccess`). */
export const PREVIEW_SIGNED_IN = ['signedin', 'full', 'suspended'].includes(seed)

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

const USER = {
  id: 'usr_preview',
  email: 'reader@example.com',
  emailVerified: true,
  displayName: 'Hamish',
  avatarUrl: null,
  plan: 'free' as const,
  status: 'active' as const
}

let status: AccountStatus = (() => {
  switch (seed) {
    case 'linking':
      return {
        signedIn: false,
        linking: { code: 'K7QM-3XPA', verifyUrl: 'http://127.0.0.1:1450/link?code=K7QM-3XPA', expiresAt: Date.now() + 600_000 },
        backup: { running: false }
      }
    case 'signedin':
    case 'full':
    case 'suspended':
      return {
        signedIn: true,
        user: seed === 'suspended' ? { ...USER, status: 'suspended' } : USER,
        usage: usage(seed === 'full'),
        linking: null,
        backup: {
          running: false,
          lastBackupAt: Date.now() - 7 * 60_000,
          lastError: seed === 'full' ? 'Your Kimochi backup is full (250 MB). Remove sessions from it under Manage account on the web, or back up preferences only.' : null
        }
      }
    default:
      return { signedIn: false, linking: null, backup: { running: false } }
  }
})()

let linkTimer: ReturnType<typeof setTimeout> | null = null

function publish(next: AccountStatus): AccountStatus {
  status = { ...next, server }
  void emit('account-changed', status)
  return status
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Handler = (args: Record<string, unknown> | undefined) => unknown

export const ACCOUNT_HANDLERS: Record<string, Handler> = {
  account_status: () => ({ ...status, server }),
  account_set_server: (args) => {
    const mode = args?.mode === 'local' ? 'local' : 'cloud'
    if (server.forced) throw 'invalid: KIMOCHI_SERVER=local picks the server for this run; unset it to switch here'
    if (mode === server.mode) return status
    if (linkTimer) clearTimeout(linkTimer)
    if (status.linking) void emit('account-link', { status: 'cancelled', code: status.linking.code })
    const leaving: AccountStatus = { ...status, linking: null }
    server = serverFor(mode)
    const next = parked
    parked = leaving
    void emit('settings:changed', { key: 'serverSettings', value: { mode } })
    return publish(next)
  },
  account_link_start: () => {
    const code = 'K7QM-3XPA'
    const verifyUrl = `http://127.0.0.1:1450/link?code=${code}`
    publish({ ...status, linking: { code, verifyUrl, expiresAt: Date.now() + 600_000 } })
    void emit('account-link', { status: 'pending', code })
    console.info('[preview] account_link_start: the browser would open', verifyUrl)
    if (linkTimer) clearTimeout(linkTimer)
    linkTimer = setTimeout(() => {
      void emit('account-link', { status: 'approved', code })
      publish({
        signedIn: true,
        user: USER,
        usage: usage(false),
        linking: null,
        backup: { running: false, lastBackupAt: null, lastError: null }
      })
    }, 6000)
    return { code, verifyUrl, expiresIn: 600 }
  },
  account_link_cancel: () => {
    if (linkTimer) clearTimeout(linkTimer)
    void emit('account-link', { status: 'cancelled', code: status.linking?.code ?? '' })
    return publish({ ...status, linking: null })
  },
  account_link_open: () => console.info('[preview] account_link_open'),
  account_sign_out: () => publish({ signedIn: false, linking: null, backup: { running: false } }),
  account_refresh: () => status,
  account_open_web: () => console.info('[preview] account_open_web: http://127.0.0.1:1450/account'),
  account_backup_now: async () => {
    publish({ ...status, backup: { ...status.backup, running: true } })
    void emit('account-backup', { phase: 'scanning', done: 0, total: 0 })
    await wait(700)
    for (let done = 0; done <= 4; done += 1) {
      void emit('account-backup', { phase: 'uploading', done, total: 4 })
      await wait(450)
    }
    void emit('account-backup', { phase: 'done', done: 1, total: 1 })
    return publish({ ...status, backup: { running: false, lastBackupAt: Date.now(), lastError: null } })
  },
  account_restore: async () => {
    publish({ ...status, backup: { ...status.backup, running: true } })
    for (let done = 0; done <= 6; done += 1) {
      void emit('account-backup', { phase: 'downloading', done, total: 6 })
      await wait(300)
    }
    publish({ ...status, backup: { ...status.backup, running: false } })
    void emit('account-backup', { phase: 'error', done: 0, total: 0, error: 'The browser preview cannot restart.' })
    throw 'native: The browser preview cannot restart Kimochi to finish a restore.'
  },
  cloud_translate: () => {
    if (!status.signedIn)
      throw 'native: Kimochi cloud translation needs a Kimochi account. Sign in from Settings → Account, or use your own DeepL key in Settings → Translation & AI.'
    return '(Preview) Kimochi cloud translation would appear here.'
  }
}
