/**
 * Settings → Account: the accounts on this computer and which one Kimochi is used as (each keeps
 * its own Log, notebook and preferences; "Local" is no account), adding one (a local account, or
 * a Kimochi Cloud sign-in), naming local ones, and for the Kimochi account in use its allowances
 * and Sync. Everything runs in Rust (`account.rs`, `sync.rs`); this page shows
 * their state (`useAccount`, `useSync`) and sends the commands. A token never reaches it.
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import {
  Check,
  ChevronDown,
  Cloud,
  Globe,
  Download,
  ExternalLink,
  Laptop,
  LogOut,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  ScrollText,
  Trash2,
  UserPlus
} from 'lucide-react'
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  Spinner
} from '@kit'
import {
  accountBarName,
  accountName,
  activeAccount,
  formatBytes,
  hasCloudAccount,
  localProfileName,
  localProfileUser,
  PLAN_LABELS,
  planNote,
  resetLine,
  usageRows,
  type AccountStatus,
  type AccountSummary,
  type UsageRow
} from '@ui/account'
import { languageOf } from '@ui/languages'
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
import { useLanguage } from '../../bridge/useLanguage'
import { AccountAvatar } from '../../components/AccountAvatar'
import { AccountDictionaryProfile } from './DictionaryProfileSection'
import { LocalAccountDialog, type LocalAccountEdit } from './LocalAccountDialog'
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
  const cloudActive = active?.kind === 'cloud' ? active : null
  return (
    <SettingsPage
      title="Account"
      description="Settings, sessions and your notebook are saved per account. Local accounts stay on this computer; Kimochi Cloud accounts sync."
    >
      {account.linking && <Linking code={account.linking.code} />}
      <AccountsSection account={account} />
      {!account.linking && !hasCloudAccount(account) && <CloudOffer />}
      {cloudActive && account.signedIn && <SignedIn account={account} />}
      {cloudActive && !cloudActive.signedIn && <NeedsSignIn summary={cloudActive} />}
      {DEV_BUILD && <ServerSection account={account} />}
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
 * server in use). `KIMOCHI_SERVER` in the environment (`npm run dev:local`) starts the run on one,
 * until the other is chosen here or an account on it is switched to.
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
  const [open, setOpen] = useState(false)
  return (
    <SettingsSection
      title="Developer"
      description="Development build only: the Kimochi server new accounts sign in to."
      grouped={open}
      actions={
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          className="account-dev-toggle"
          data-open={open || undefined}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown />
          {open ? 'Hide' : 'Show'}
        </Button>
      }
    >
      {open && (
        <SettingsRow
          label="Sign in to"
          badge={server?.forced ? <Badge tone="neutral">KIMOCHI_SERVER</Badge> : undefined}
          description={
            <>
              New accounts sign in at <span className="k-mono">{server?.url || 'unknown'}</span>.
              {server?.forced
                ? ' KIMOCHI_SERVER started this run here; choosing the other server, or switching to an account on it, takes over.'
                : ''}
            </>
          }
        >
          <Select
            aria-label="Server for new sign-ins"
            value={server?.mode}
            disabled={busy || !server}
            onValueChange={switchTo}
            options={SERVER_OPTIONS}
          />
        </SettingsRow>
      )}
      {open && error && <Callout tone="danger">{error}</Callout>}
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

/** No Kimochi account here yet: what Kimochi Cloud adds, and signing in. */
function CloudOffer(): ReactNode {
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
    <SettingsSection title="Kimochi Cloud">
      <SettingsRow
        label="Cloud subscription"
        description="Kimochi Cloud needs an account. It adds cloud OCR, read aloud, translation, AI explanations and Sync. Try it free for 14 days."
      >
        <Button variant="primary" size="sm" disabled={busy} onClick={start}>
          Sign in or create an account
        </Button>
      </SettingsRow>
      {error && <Callout tone="danger">{error}</Callout>}
    </SettingsSection>
  )
}

function Linking({ code }: { code: string }): ReactNode {
  const [error, setError] = useState('')
  return (
    <SettingsSection
      title="Finish signing in in your browser"
      description="Check that the browser shows this code, then confirm it there."
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
        description="If the browser didn't open, or you closed it, open it again."
      >
        <Button size="sm" onClick={() => void accountLinkOpen().catch((caught: unknown) => setError(message(caught)))}>
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

/** Where Switch is on the other rows: the account in use, as a button that can't be pressed. */
function ActiveButton(): ReactNode {
  return (
    <Button size="sm" disabled className="account-active-button">
      <Check />
      Active
    </Button>
  )
}

/** An account's second line: Local or Cloud with its icon, then the language it reads, then any note. */
function AccountKind({
  local,
  language,
  children
}: {
  local: boolean
  language: string | null | undefined
  children?: ReactNode
}): ReactNode {
  return (
    <span className="account-kind">
      {local ? <Laptop aria-hidden /> : <Cloud aria-hidden />}
      {local ? 'Local' : 'Cloud'}
      {language && (
        <>
          <span aria-hidden>·</span>
          <Globe aria-hidden />
          {languageOf(language).name}
        </>
      )}
      {children ? <span className="account-kind-detail">· {children}</span> : null}
    </span>
  )
}

/** The name, then the email in the description's style. */
function AccountName({ name, email }: { name: string; email?: string | null }): ReactNode {
  return (
    <span className="account-name">
      <span className="account-name-text">{name}</span>
      {email && email !== name && <span className="account-name-email">{email}</span>}
    </span>
  )
}

/** Every account on this computer, and Local: which one Kimochi is used as. */
function AccountsSection({ account }: { account: AccountStatus }): ReactNode {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<AccountSummary | null>(null)
  const [editing, setEditing] = useState<LocalAccountEdit | null>(null)
  // Each opening of the dialog starts from what it was opened with.
  const [editCount, setEditCount] = useState(0)
  const accounts = account.accounts ?? []
  const localActive = !accounts.some((a) => a.active)
  const localUser = localProfileUser(account)
  // The live setting, not the account's report: changing language sends no account update.
  const [language] = useLanguage()
  const run = (work: () => Promise<unknown>): void => {
    setBusy(true)
    setError('')
    work()
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false))
  }
  const edit = (next: LocalAccountEdit): void => {
    setEditCount((n) => n + 1)
    setEditing(next)
  }
  const disabled = busy || account.switching === true
  const removingLocal = removing?.kind === 'local'
  return (
    <SettingsSection
      title="Accounts"
      actions={
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={disabled}>
              <UserPlus />
              Add account
            </Button>
          </MenuTrigger>
          <MenuContent align="end" className="account-add-menu">
            <MenuItem className="k-menu-item-described" icon={<Laptop />} onSelect={() => edit({ mode: 'create' })}>
              Local account
              <span className="k-menu-item-description">Kept on this computer. Free, no sign-in.</span>
            </MenuItem>
            <MenuItem
              className="k-menu-item-described"
              icon={<Cloud />}
              disabled={Boolean(account.linking)}
              onSelect={() => run(accountLinkStart)}
            >
              Cloud subscription
              <span className="k-menu-item-description">Kimochi Cloud: Sync, cloud OCR and more.</span>
            </MenuItem>
          </MenuContent>
        </Menu>
      }
    >
      {accounts.map((a) => {
        const primary = accountBarName(a.user)
        const email = a.user?.email?.trim() || null
        const local = a.kind === 'local'
        const description = (
          <AccountKind local={local} language={a.active ? language.code : a.language}>
            {a.server?.mode === 'local' ? 'local server' : null}
          </AccountKind>
        )
        return (
          <Fragment key={a.key}>
            <SettingsRow
              leading={<AccountAvatar user={a.user} className="account-row-avatar" />}
              label={<AccountName name={primary} email={email} />}
              className={a.active ? 'account-row-active' : undefined}
              badge={!local && !a.signedIn ? <Badge tone="neutral">Signed out</Badge> : undefined}
              description={description}
            >
              {a.active ? (
                <ActiveButton />
              ) : (
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
                  {local ? (
                    <MenuItem
                      icon={<Pencil />}
                      onSelect={() =>
                        edit({ mode: 'edit', key: a.key, name: primary, avatar: a.user?.avatarUrl ?? null })
                      }
                    >
                      Edit…
                    </MenuItem>
                  ) : (
                    <>
                      <MenuItem icon={<ExternalLink />} onSelect={() => run(() => accountOpenWeb(a.key))}>
                        View details online
                      </MenuItem>
                      {a.signedIn && (
                        <MenuItem icon={<LogOut />} onSelect={() => run(() => accountSignOut(a.key))}>
                          Sign out
                        </MenuItem>
                      )}
                    </>
                  )}
                  <MenuSeparator />
                  <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => setRemoving(a)}>
                    {local ? 'Delete account…' : 'Remove from this computer…'}
                  </MenuItem>
                </MenuContent>
              </Menu>
            </SettingsRow>
            {a.active && <AccountDictionaryProfile />}
          </Fragment>
        )
      })}
      <SettingsRow
        leading={<AccountAvatar user={localUser} local className="account-row-avatar" />}
        label={localProfileName(account)}
        className={localActive ? 'account-row-active' : undefined}
        description={
          <AccountKind local language={localActive ? language.code : account.localLanguage}>
            The default account Kimochi starts with.
          </AccountKind>
        }
      >
        {localActive ? (
          <ActiveButton />
        ) : (
          <Button size="sm" disabled={disabled} onClick={() => run(() => accountSwitch(null))}>
            Switch
          </Button>
        )}
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={`More for ${localProfileName(account)}`} size="sm" disabled={disabled}>
              <MoreHorizontal />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem
              icon={<Pencil />}
              onSelect={() =>
                edit({
                  mode: 'edit',
                  key: null,
                  name: account.localProfile?.displayName ?? '',
                  avatar: account.localProfile?.avatarUrl ?? null
                })
              }
            >
              Edit…
            </MenuItem>
          </MenuContent>
        </Menu>
      </SettingsRow>
      {localActive && <AccountDictionaryProfile />}
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
      {editing && <LocalAccountDialog key={editCount} edit={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={
          removingLocal
            ? `Delete ${accountName(removing?.user)}?`
            : `Remove ${accountName(removing?.user)} from this computer?`
        }
        description={
          removingLocal
            ? "Deletes this account's sessions, notebook and preferences. A local account isn't stored anywhere else, so this can't be undone."
            : "Signs out and deletes this account's sessions, notebook and preferences from this computer. What has synced stays in your account; anything not synced yet is lost."
        }
        confirmLabel={removingLocal ? 'Delete' : 'Remove'}
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
        description="The sign-in was revoked or expired. Your data is still here; Sync and Kimochi cloud resume once you sign in again."
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
  const plan = user?.plan ?? account.usage?.plan
  const note = planNote(user)
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
          badge={
            plan ? <Badge tone={account.cloud ? 'accent' : 'neutral'}>{PLAN_LABELS[plan] ?? plan}</Badge> : undefined
          }
          description={[user?.displayName && user.email ? user.email : 'Signed in on this computer.', note]
            .filter(Boolean)
            .join(' ')}
        >
          <Button size="sm" onClick={() => void accountOpenWeb().catch((caught: unknown) => setError(message(caught)))}>
            <ExternalLink />
            Manage account
          </Button>
        </SettingsRow>
        {user?.status === 'suspended' && (
          <Callout tone="warn">
            This account is suspended, so Kimochi cloud services are unavailable. See Manage account for details.
          </Callout>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </SettingsSection>

      {/* Without Kimochi Cloud there is no usage to show and nothing syncs: one row says where to get it. */}
      {account.cloud ? (
        <>
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
        </>
      ) : (
        <SettingsSection title="Kimochi Cloud">
          <SettingsRow
            label="Not on this account"
            description="Kimochi Cloud adds cloud OCR, read aloud, translation, AI explanations and Sync. Start a 14-day free trial on the website; Kimochi picks it up within a few minutes, or press Refresh."
          >
            <Button
              size="sm"
              variant="primary"
              onClick={() => void accountOpenWeb().catch((caught: unknown) => setError(message(caught)))}
            >
              <ExternalLink />
              See plans
            </Button>
            <Button size="sm" variant="ghost" disabled={refreshing} onClick={refresh}>
              <RefreshCw />
              Refresh
            </Button>
          </SettingsRow>
        </SettingsSection>
      )}

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
    resolveConflict(conflict.id, action).catch((caught: unknown) => {
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
      description="Your sessions, notebook, presets and preferences sync with your other computers on this account. Keys and this computer's own settings don't."
    >
      <SettingsRow label="Sync now" description={<span className="k-num">{syncStateLine(sync, now)}</span>}>
        {syncing && <Spinner label="Syncing" />}
        <Button
          size="sm"
          disabled={syncing}
          onClick={() => void syncNow().catch((caught: unknown) => setError(message(caught)))}
        >
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
            ? 'Changed on two computers at once. The newer change was kept; restore the other or dismiss it.'
            : 'None.'
        }
      />
      {sync.conflicts.map((conflict) => (
        <ConflictRow key={conflict.id} conflict={conflict} />
      ))}
      <SettingsRow label="Sync log" description="A timestamped record of what Sync sent, received, merged and kept.">
        <Button
          size="sm"
          onClick={() => void panel('sync-log', 'show').catch((caught: unknown) => setError(message(caught)))}
        >
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
