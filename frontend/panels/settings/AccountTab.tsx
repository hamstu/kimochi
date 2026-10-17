/**
 * Settings → Account: the optional Kimochi account. Signed out, one explanation and Sign in;
 * while linking, the code to check in the browser; signed in, who it is, this month's allowances,
 * backup and restore, and Sign out. Everything runs in Rust (`account.rs`); this page shows its
 * state (`useAccount`) and sends the commands. The account token never reaches it.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  Spinner,
  Switch
} from '@kit'
import {
  accountName,
  backupProgressLine,
  DEFAULT_BACKUP_OPTIONS,
  lastBackupLine,
  PLAN_LABELS,
  resetLine,
  usageRows,
  type AccountStatus,
  type BackupOptions,
  type UsageRow
} from '@ui/account'
import {
  accountBackupNow,
  accountLinkCancel,
  accountLinkOpen,
  accountLinkStart,
  accountOpenWeb,
  accountRefresh,
  accountRestore,
  accountSetServer,
  accountSignOut,
  clearAccountEvents,
  useAccount,
  useBackupEvent,
  useLinkEvent
} from '../../bridge/account'
import { nativeError } from '../../bridge/tauri'
import { DEV_BUILD } from '../../bridge/devBuild'
import { useSetting } from '../../bridge/useSetting'
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
  return (
    <SettingsPage
      title="Account"
      description="Optional. Everything else in Kimochi works without one."
    >
      {DEV_BUILD && <ServerSection account={account} />}
      {account.signedIn ? (
        <SignedIn account={account} />
      ) : account.linking ? (
        <Linking code={account.linking.code} />
      ) : (
        <SignedOut />
      )}
    </SettingsPage>
  )
}

const SERVER_OPTIONS = [
  { value: 'cloud', label: 'Production' },
  { value: 'local', label: 'Local' }
] as const

/**
 * Development builds only: which Kimochi server this copy talks to. Each server has its own
 * sign-in, and the switch applies at once (`account_set_server`). `KIMOCHI_SERVER` in the
 * environment (`npm run dev:local`) pins it for the run.
 */
function ServerSection({ account }: { account: AccountStatus }): ReactNode {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const server = account.server
  const switchTo = (mode: 'cloud' | 'local'): void => {
    if (mode === server?.mode) return
    setBusy(true)
    setError('')
    accountSetServer(mode)
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setBusy(false))
  }
  return (
    <SettingsSection title="Server" description="Development build only. Each server keeps its own sign-in.">
      <SettingsRow
        label="Kimochi server"
        badge={server?.forced ? <Badge tone="neutral">KIMOCHI_SERVER</Badge> : undefined}
        description={
          <>
            Using <span className="k-mono">{server?.url || 'unknown'}</span>.
            {server?.forced
              ? ' Set by KIMOCHI_SERVER in the environment for this run.'
              : ' Switching applies at once.'}
          </>
        }
      >
        <Select
          aria-label="Kimochi server"
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
        description="Signing in unlocks cloud OCR, read aloud, translation and explanations within free monthly allowances, and backup of your preferences and sessions."
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
            This account is suspended, so Kimochi cloud services are unavailable. Your backups are still
            there; see Manage account for details.
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

      <BackupSection account={account} />

      <SettingsSection>
        <SettingsRow
          label="Sign out"
          description="Kimochi cloud stops on this computer. Your backup stays in your account."
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

function BackupSection({ account }: { account: AccountStatus }): ReactNode {
  const [options, setOptions] = useSetting<BackupOptions>('accountBackup', DEFAULT_BACKUP_OPTIONS)
  const event = useBackupEvent()
  const now = useNow()
  const [error, setError] = useState('')
  const [restoreOpen, setRestoreOpen] = useState(false)
  const running = account.backup?.running ?? false
  const progress = running ? backupProgressLine(event) : null
  const failure = error || (event?.phase === 'error' ? event.error : null) || account.backup?.lastError
  const enabled = options.prefs || options.sessions

  const backUp = (): void => {
    setError('')
    accountBackupNow().catch((caught: unknown) => setError(message(caught)))
  }

  return (
    <SettingsSection
      title="Backup"
      description="Keeps a copy in your Kimochi account, updated a couple of minutes after things change. Your DeepL key and other secrets are never uploaded."
    >
      <SettingsRow
        label="Preferences"
        controlId="account-backup-prefs"
        description="Settings, presets and reading stats."
      >
        <Switch
          id="account-backup-prefs"
          checked={options.prefs}
          onCheckedChange={(prefs) => void setOptions({ ...options, prefs })}
        />
      </SettingsRow>
      <SettingsRow
        label="Sessions"
        controlId="account-backup-sessions"
        description="Every session's lines, notebook and images. Images count towards your backup storage."
      >
        <Switch
          id="account-backup-sessions"
          checked={options.sessions}
          onCheckedChange={(sessions) => void setOptions({ ...options, sessions })}
        />
      </SettingsRow>
      <SettingsRow
        label="Back up now"
        description={
          <span className="k-num">
            {progress ?? (enabled ? lastBackupLine(account.backup?.lastBackupAt, now) : 'Turn on preferences or sessions to back them up.')}
          </span>
        }
      >
        {running && <Spinner label="Backing up" />}
        <Button size="sm" disabled={!enabled || running} onClick={backUp}>
          Back up now
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Restore from backup"
        description="Brings this computer back to your backup, then restarts Kimochi."
      >
        <Button size="sm" disabled={running} onClick={() => setRestoreOpen(true)}>
          Restore…
        </Button>
      </SettingsRow>
      {failure && <Callout tone="danger">{failure}</Callout>}
      <RestoreDialog open={restoreOpen} onOpenChange={setRestoreOpen} />
    </SettingsSection>
  )
}

function RestoreDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactNode {
  const [prefs, setPrefs] = useState(true)
  const [sessions, setSessions] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const event = useBackupEvent()
  const progress = busy ? backupProgressLine(event) : null

  const restore = (): void => {
    setBusy(true)
    setError('')
    // On success Kimochi restarts, so there is nothing to reset afterwards.
    accountRestore(prefs, sessions).catch((caught: unknown) => {
      setError(message(caught))
      setBusy(false)
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        title="Restore from backup?"
        description="Kimochi downloads your backup and restarts to put it in place."
        footer={
          <>
            {progress && <span className="k-description k-num">{progress}</span>}
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || (!prefs && !sessions)} onClick={restore}>
              Restore and restart
            </Button>
          </>
        }
      >
        <div className="account-restore-options">
          <label className="account-restore-option">
            <Checkbox checked={prefs} onCheckedChange={(value) => setPrefs(value === true)} disabled={busy} />
            <span>
              Preferences
              <span className="k-description account-restore-detail">
                Replace this computer&apos;s settings, presets and stats. Your DeepL key, window positions
                and chosen source stay as they are.
              </span>
            </span>
          </label>
          <label className="account-restore-option">
            <Checkbox checked={sessions} onCheckedChange={(value) => setSessions(value === true)} disabled={busy} />
            <span>
              Sessions
              <span className="k-description account-restore-detail">
                Add the backed-up sessions. A session on both keeps whichever copy changed last;
                sessions only on this computer stay.
              </span>
            </span>
          </label>
          {error && <Callout tone="danger">{error}</Callout>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
