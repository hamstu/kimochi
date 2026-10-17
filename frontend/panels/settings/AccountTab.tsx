/**
 * Settings → Account: the accounts on this computer and which one Kimochi is used as (each keeps
 * its own Log, notebook and preferences; "Local" is no account), adding one, and for the account
 * in use its allowances and Sync. Everything runs in Rust (`account.rs`, `sync.rs`); this page shows
 * their state (`useAccount`, `useSync`) and sends the commands. A token never reaches it.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { Download, ExternalLink, MoreHorizontal, RefreshCw, ScrollText, UserPlus } from 'lucide-react'
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  Spinner
} from '@kit'
import {
  accountLines,
  accountName,
  activeAccount,
  formatBytes,
  PLAN_LABELS,
  resetLine,
  usageRows,
  type AccountStatus,
  type AccountSummary,
  type UsageRow
} from '@ui/account'
import { conflictDetail, conflictTitle, syncStateLine, type SyncConflict } from '@ui/sync'
import {
  accountLinkCancel,
  accountLinkOpen,
  accountLinkStart,
  accountOpenWeb,
  accountRefresh,
  accountRemove,
  accountSetServer,
  accountSignOut,
  accountSwitch,
  clearAccountEvents,
  useAccount,
  useLinkEvent
} from '../../bridge/account'
import { exportSyncedData, resolveConflict, syncNow, useSync } from '../../bridge/sync'
import { nativeError, panel } from '../../bridge/tauri'
import { DEV_BUILD } from '../../bridge/devBuild'
import { AccountAvatar } from '../../components/AccountAvatar'
import './account.css'

const message = (error: unknown): string => nativeError(error).message

/** "checked 4 minutes ago" moves on its own: the clock, once a minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

export function AccountTab(): ReactNode {
  const account = useAccount()
  const active = activeAccount(account)
  const accounts = account.accounts ?? []
  return (
    <SettingsPage
      title="Account"
      description="Optional. Everything else in Kimochi works without one."
    >
      {DEV_BUILD && <ServerSection account={account} />}
      {account.linking && <Linking code={account.linking.code} />}
      {accounts.length > 0 ? (
        <AccountsSection account={account} />
      ) : (
        !account.linking && <SignedOut />
      )}
      {active && account.signedIn && <SignedIn account={account} />}
      {active && !active.signedIn && <NeedsSignIn summary={active} />}
    </SettingsPage>
  )
}

const SERVER_OPTIONS = [
  { value: 'cloud', label: 'Production' },
  { value: 'local', label: 'Local' }
] as const

/**
 * Development builds only: which Kimochi server "Add account" signs in to. Every account keeps its
 * own server, so this only matters for the next sign-in (and, while no account is in use, for the
 * server in use). `KIMOCHI_SERVER` in the environment (`npm run dev:local`) pins it for the run.
 */
function ServerSection({ account }: { account: AccountStatus }): ReactNode {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const server = account.linkServer ?? account.server
  const switchTo = (mode: 'cloud' | 'local'): void => {
    if (mode === server?.mode) return
    setBusy(true)
    setError('')
    accountSetServer(mode)
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false))
  }
  return (
    <SettingsSection title="Server" description="Development build only. Each account keeps its own server.">
      <SettingsRow
        label="Sign in to"
        badge={server?.forced ? <Badge tone="neutral">KIMOCHI_SERVER</Badge> : undefined}
        description={
          <>
            New accounts sign in at <span className="k-mono">{server?.url || 'unknown'}</span>.
            {server?.forced ? ' Set by KIMOCHI_SERVER in the environment for this run.' : ''}
          </>
        }
      >
        <Select
          aria-label="Server for new sign-ins"
          value={server?.mode}
          disabled={busy || !server || server.forced}
          onValueChange={switchTo}
          options={SERVER_OPTIONS}
        />
      </SettingsRow>
      {error && <Callout tone="danger">{error}</Callout>}
    </SettingsSection>
  )
}

function LinkOutcome(): ReactNode {
  const link = useLinkEvent()
  if (!link) return null
  switch (link.status) {
    case 'denied':
      return <Callout tone="warn">Sign-in was declined in the browser. Try again when you&apos;re ready.</Callout>
    case 'expired':
      return <Callout tone="warn">The sign-in code expired before it was confirmed. Start again for a new one.</Callout>
    case 'error':
      return <Callout tone="danger">{link.message || 'Signing in failed. Try again.'}</Callout>
    default:
      return null
  }
}

function SignedOut(): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = (): void => {
    setBusy(true)
    setError('')
    accountLinkStart()
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false))
  }
  return (
    <SettingsSection title="Kimochi account">
      <SettingsRow
        label="Kimochi cloud"
        description="Signing in unlocks cloud OCR, read aloud, translation and explanations within free monthly allowances, and keeps your sessions, notebook and preferences in sync across your computers."
      >
        <Button variant="primary" size="sm" disabled={busy} onClick={start}>
          Sign in or create an account
        </Button>
      </SettingsRow>
      {error && <Callout tone="danger">{error}</Callout>}
      <LinkOutcome />
    </SettingsSection>
  )
}

function Linking({ code }: { code: string }): ReactNode {
  const [error, setError] = useState('')
  return (
    <SettingsSection
      title="Finish signing in in your browser"
      description="Check that the browser shows this code, then confirm it there. Kimochi comes back here once you have."
    >
      <div className="account-code">
        <span className="k-description">Your code</span>
        <span className="account-code-value" aria-label={`Code ${code.split('').join(' ')}`}>
          {code}
        </span>
      </div>
      <SettingsRow
        label={
          <span className="account-waiting">
            <Spinner label="Waiting for the browser" />
            Waiting for confirmation…
          </span>
        }
        description="The browser didn't open, or you closed it? Open it again."
      >
        <Button
          size="sm"
          onClick={() => void accountLinkOpen().catch((caught: unknown) => setError(message(caught)))}
        >
          Open browser again
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void accountLinkCancel()}>
          Cancel
        </Button>
      </SettingsRow>
      {error && <Callout tone="danger">{error}</Callout>}
    </SettingsSection>
  )
}

/** Every account on this computer, and Local: which one Kimochi is used as. */
function AccountsSection({ account }: { account: AccountStatus }): ReactNode {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<AccountSummary | null>(null)
  const accounts = account.accounts ?? []
  const localActive = !accounts.some((a) => a.active)
  const run = (work: () => Promise<unknown>): void => {
    setBusy(true)
    setError('')
    work()
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false))
  }
  const disabled = busy || account.switching === true
  return (
    <SettingsSection
      title="Accounts on this computer"
      description="Each account keeps its own sessions, notebook, presets and preferences, synced with your other computers. Switching swaps them; nothing is merged or deleted."
      actions={
        <Button size="sm" variant="ghost" disabled={disabled || Boolean(account.linking)} onClick={() => run(accountLinkStart)}>
          <UserPlus />
          Add account
        </Button>
      }
    >
      {accounts.map((a) => {
        const { primary, secondary } = accountLines(a.user)
        return (
          <SettingsRow
            key={a.key}
            label={
              <span className="account-who">
                <AccountAvatar user={a.user} />
                {primary}
              </span>
            }
            badge={
              a.active ? (
                <Badge tone="accent">In use</Badge>
              ) : !a.signedIn ? (
                <Badge tone="neutral">Signed out</Badge>
              ) : undefined
            }
            description={[secondary, a.server?.mode === 'local' ? 'Local server' : null].filter(Boolean).join(' · ') || undefined}
          >
            {!a.active && (
              <Button size="sm" disabled={disabled || !a.available} onClick={() => run(() => accountSwitch(a.key))}>
                Switch
              </Button>
            )}
            <Menu>
              <MenuTrigger asChild>
                <IconButton label={`More for ${primary}`} size="sm" disabled={disabled}>
                  <MoreHorizontal />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                {a.signedIn && <MenuItem onSelect={() => run(() => accountSignOut(a.key))}>Sign out</MenuItem>}
                <MenuItem tone="danger" onSelect={() => setRemoving(a)}>
                  Remove from this computer…
                </MenuItem>
              </MenuContent>
            </Menu>
          </SettingsRow>
        )
      })}
      <SettingsRow
        label={
          <span className="account-who">
            <AccountAvatar local />
            Local
          </span>
        }
        badge={localActive ? <Badge tone="accent">In use</Badge> : undefined}
        description="This computer's own Log, without an account. Not synced."
      >
        {!localActive && (
          <Button size="sm" disabled={disabled} onClick={() => run(() => accountSwitch(null))}>
            Switch
          </Button>
        )}
      </SettingsRow>
      {account.switching && (
        <SettingsRow
          label={
            <span className="account-waiting">
              <Spinner label="Switching" />
              Switching…
            </span>
          }
        />
      )}
      {error && <Callout tone="danger">{error}</Callout>}
      <LinkOutcome />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${accountName(removing?.user)} from this computer?`}
        description="Signs out and deletes this account's sessions, notebook and preferences from this computer. What has synced stays in your account, and comes back if you sign in again; anything not synced yet is lost."
        confirmLabel="Remove"
        tone="danger"
        busy={busy}
        onConfirm={() => {
          const key = removing?.key
          setRemoving(null)
          if (key) run(() => accountRemove(key))
        }}
      />
    </SettingsSection>
  )
}

function NeedsSignIn({ summary }: { summary: AccountSummary }): ReactNode {
  const [error, setError] = useState('')
  return (
    <SettingsSection title="Signed out">
      <SettingsRow
        label={`Sign in to ${accountName(summary.user)} again`}
        description="This computer is no longer signed in to this account (its sign-in was revoked or expired). Your data is still here; Sync and Kimochi cloud resume once you sign in."
      >
        <Button
          variant="primary"
          size="sm"
          onClick={() => void accountLinkStart().catch((caught: unknown) => setError(message(caught)))}
        >
          Sign in again
        </Button>
      </SettingsRow>
      {error && <Callout tone="danger">{error}</Callout>}
    </SettingsSection>
  )
}

function Meter({ row }: { row: UsageRow }): ReactNode {
  if (row.fraction === null) return null
  const level = row.exhausted ? 'full' : row.fraction >= 0.9 ? 'high' : 'normal'
  return (
    <span
      className="account-meter"
      data-level={level}
      role="meter"
      aria-label={row.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(row.fraction * 100)}
    >
      <span className="account-meter-fill" style={{ transform: `scaleX(${row.fraction})` }} />
    </span>
  )
}

function SignedIn({ account }: { account: AccountStatus }): ReactNode {
  const user = account.user
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const rows = usageRows(account.usage)
  const plan = account.usage?.plan ?? user?.plan
  const refresh = (): void => {
    setRefreshing(true)
    setError('')
    accountRefresh()
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setRefreshing(false))
  }
  return (
    <>
      <SettingsSection title="Kimochi account">
        <SettingsRow
          label={accountName(user)}
          badge={plan ? <Badge tone={plan === 'free' ? 'neutral' : 'accent'}>{PLAN_LABELS[plan]}</Badge> : undefined}
          description={user?.displayName && user.email ? user.email : 'Signed in on this computer.'}
        >
          <Button size="sm" onClick={() => void accountOpenWeb().catch((caught: unknown) => setError(message(caught)))}>
            <ExternalLink />
            Manage account
          </Button>
        </SettingsRow>
        {user?.status === 'suspended' && (
          <Callout tone="warn">
            This account is suspended, so Kimochi cloud services are unavailable. Your data still syncs; see
            Manage account for details.
          </Callout>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </SettingsSection>

      <SettingsSection
        title="This month"
        description={resetLine(account.usage) ?? 'Your allowances appear here once Kimochi cloud answers.'}
        actions={
          <Button size="sm" variant="ghost" disabled={refreshing} onClick={refresh}>
            <RefreshCw />
            Refresh
          </Button>
        }
      >
        {rows.length > 0 ? (
          rows.map((row) => (
            <SettingsRow
              key={row.metric}
              label={row.label}
              description={
                <>
                  <span className="k-num">{row.amount}</span>
                  <Meter row={row} />
                </>
              }
            />
          ))
        ) : (
          <SettingsRow label="Usage" description="Not loaded yet. Refresh to try again." />
        )}
      </SettingsSection>

      <SyncSection />

      <SettingsSection>
        <SettingsRow
          label="Sign out"
          description="Kimochi switches to Local. This account's data stays on this computer, ready when you sign in again."
        >
          <Button
            size="sm"
            onClick={() => {
              clearAccountEvents()
              void accountSignOut().catch((caught: unknown) => setError(message(caught)))
            }}
          >
            Sign out
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  )
}

function ConflictRow({ conflict }: { conflict: SyncConflict }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const act = (action: 'restore' | 'dismiss'): void => {
    setBusy(true)
    setError('')
    resolveConflict(conflict.id, action)
      .catch((caught: unknown) => {
        setError(message(caught))
        setBusy(false)
      })
  }
  const when = conflict.detectedAt ? new Date(conflict.detectedAt).toLocaleString() : ''
  return (
    <SettingsRow
      label={conflictTitle(conflict)}
      description={
        <>
          {conflictDetail(conflict)}
          {when && <span className="account-conflict-when k-num"> · {when}</span>}
          {error && <span className="account-conflict-error"> {error}</span>}
        </>
      }
    >
      <Button size="sm" disabled={busy} onClick={() => act('restore')}>
        Restore
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => act('dismiss')}>
        Dismiss
      </Button>
    </SettingsRow>
  )
}

function SyncSection(): ReactNode {
  const sync = useSync()
  const now = useNow()
  const [error, setError] = useState('')
  const [exported, setExported] = useState('')
  const [exporting, setExporting] = useState(false)
  const syncing = sync.state === 'syncing'
  const storage =
    sync.used === null
      ? null
      : sync.limit === null
        ? `${formatBytes(sync.used)} used`
        : `${formatBytes(sync.used)} of ${formatBytes(sync.limit)}`
  const fraction = sync.used !== null && sync.limit ? Math.min(1, sync.used / sync.limit) : null

  const exportData = async (): Promise<void> => {
    setError('')
    setExported('')
    const day = new Date().toISOString().slice(0, 10)
    const path = await save({
      title: 'Export your synced data',
      defaultPath: `kimochi-export-${day}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
    })
    if (!path) return
    setExporting(true)
    try {
      const bytes = await exportSyncedData(path)
      setExported(`Saved ${formatBytes(bytes)} to ${path}.`)
    } catch (caught) {
      setError(message(caught))
    } finally {
      setExporting(false)
    }
  }

  return (
    <SettingsSection
      title="Sync"
      description="Your sessions, notebook, presets and preferences stay on this computer and sync in the background with your other computers signed in to this account, even after time offline. Your DeepL key, other secrets and this computer's own settings never leave it."
    >
      <SettingsRow label="Sync now" description={<span className="k-num">{syncStateLine(sync, now)}</span>}>
        {syncing && <Spinner label="Syncing" />}
        <Button size="sm" disabled={syncing} onClick={() => void syncNow().catch((caught: unknown) => setError(message(caught)))}>
          <RefreshCw />
          Sync now
        </Button>
      </SettingsRow>
      {sync.state === 'error' && sync.lastError && <Callout tone="danger">{sync.lastError}</Callout>}
      {storage && (
        <SettingsRow
          label="Storage"
          description={
            <>
              <span className="k-num">{storage}</span>
              {fraction !== null && (
                <span
                  className="account-meter"
                  data-level={fraction >= 1 ? 'full' : fraction >= 0.9 ? 'high' : 'normal'}
                  role="meter"
                  aria-label="Sync storage"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(fraction * 100)}
                >
                  <span className="account-meter-fill" style={{ transform: `scaleX(${fraction})` }} />
                </span>
              )}
            </>
          }
        />
      )}
      <SettingsRow
        label="Conflicts"
        badge={sync.conflicts.length > 0 ? <Badge tone="warn">{sync.conflicts.length}</Badge> : undefined}
        description={
          sync.conflicts.length > 0
            ? 'Changed on two computers at once. The newer change was kept everywhere; the other is below. Restore it to make it current again, or dismiss it.'
            : 'None. When something changes on two computers at once, the newer change wins and the other is kept here.'
        }
      />
      {sync.conflicts.map((conflict) => (
        <ConflictRow key={conflict.id} conflict={conflict} />
      ))}
      <SettingsRow label="Sync log" description="A timestamped record of what Sync sent, received, merged and kept.">
        <Button size="sm" onClick={() => void panel('sync-log', 'show').catch((caught: unknown) => setError(message(caught)))}>
          <ScrollText />
          View sync log
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Export your data"
        description="Everything this account has synced, as a ZIP of plain JSON files and images. Also on the website, under Manage account."
      >
        {exporting && <Spinner label="Exporting" />}
        <Button size="sm" disabled={exporting} onClick={() => void exportData()}>
          <Download />
          Export…
        </Button>
      </SettingsRow>
      {exported && <Callout tone="ok">{exported}</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}
    </SettingsSection>
  )
}
