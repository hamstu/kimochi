import { useCallback, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Laptop } from 'lucide-react'
import { Button, buttonClass } from '../Button'
import { Field } from './Field'
import { Notice } from './Notice'
import { SubmitButton, dangerButtonExtra } from './SubmitButton'
import { Meter } from './Meter'
import { AccountSection, Badge, ConfirmButton, StatusLine, useLoad } from './parts'
import { api, ApiError, EXPORT_URL, oauthStartUrl, type MetricName, type Provider, type User } from '../../lib/api'
import {
  deleteConfirmMatches,
  formatDay,
  formatResetDay,
  formatStorage,
  messageForCode,
  planLabel,
  platformLabel,
  relativeTime,
  resetDay
} from '../../lib/account.js'
import { useSession } from '../../lib/session'
import { MAX_PASSWORD, MIN_PASSWORD, passwordProblem } from '../../pages/AccountSignUp'

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : messageForCode('internal'))

/* ------------------------------------------------------------------ profile */

export function ProfileSection({ user }: { user: User }) {
  const { setUser } = useSession()
  const [name, setName] = useState(user.displayName ?? '')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [resend, setResend] = useState<'idle' | 'busy' | 'sent'>('idle')
  const [resendError, setResendError] = useState<string | null>(null)

  async function onSave(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setStatus(null)
    try {
      setUser(await api.updateProfile(name.trim()))
      setStatus({ tone: 'ok', text: 'Saved.' })
    } catch (err) {
      setStatus({ tone: 'danger', text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  async function onResend() {
    setResend('busy')
    setResendError(null)
    try {
      await api.resendVerification()
      setResend('sent')
    } catch (err) {
      setResend('idle')
      setResendError(errorText(err))
    }
  }

  const unchanged = name.trim() === (user.displayName ?? '')

  return (
    <AccountSection id="profile" title="Profile" description="Your name and the email you sign in with.">
      <div className="grid gap-8">
        <form onSubmit={onSave} className="grid gap-3">
          <Field
            label="Name"
            name="name"
            autoComplete="nickname"
            value={name}
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value)
              setStatus(null)
            }}
            disabled={busy}
          />
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton variant="secondary" busy={busy} busyLabel="Saving…" disabled={unchanged}>
              Save name
            </SubmitButton>
            {status && <StatusLine tone={status.tone}>{status.text}</StatusLine>}
          </div>
        </form>

        <div>
          <p className="text-small font-medium text-ink">Email</p>
          {user.email ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="text-ink break-all">{user.email}</span>
              {user.emailVerified ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Not verified</Badge>}
            </div>
          ) : (
            <p className="mt-1.5 text-ink-2">No email address. Your sign-in provider did not share one.</p>
          )}
          {user.email && !user.emailVerified && (
            <div className="mt-3 grid gap-2">
              <p className="text-small text-ink-2">
                Check your inbox for a confirmation link. It works for 24 hours.
              </p>
              {resend === 'sent' ? (
                <StatusLine>A new link is on its way to {user.email}.</StatusLine>
              ) : (
                <div>
                  <SubmitButton type="button" variant="secondary" busy={resend === 'busy'} busyLabel="Sending…" onClick={onResend}>
                    Resend confirmation email
                  </SubmitButton>
                </div>
              )}
              {resendError && <StatusLine tone="danger">{resendError}</StatusLine>}
            </div>
          )}
        </div>
      </div>
    </AccountSection>
  )
}

/* ------------------------------------------------------------------ usage */

const MONTHLY: { key: Exclude<MetricName, 'storage'>; label: string; unit: string }[] = [
  { key: 'ocr', label: 'Cloud OCR', unit: 'scans' },
  { key: 'translate', label: 'Translation', unit: 'requests' },
  { key: 'tts', label: 'Read aloud', unit: 'lines' },
  { key: 'explain', label: 'Explanations', unit: 'answers' }
]

export function UsageSection({ user }: { user: User }) {
  const usage = useLoad(api.usage)
  const reset = usage.data ? resetDay(usage.data.period.end) : null
  const plan = usage.data?.plan ?? user.plan
  return (
    <AccountSection
      id="usage"
      title="Plan and usage"
      description="Kimochi’s hosted services count against a monthly allowance. Everything else in the app is unlimited and free."
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink">{planLabel(plan)} plan</span>
        {user.status === 'suspended' && <Badge tone="warn">Suspended</Badge>}
      </div>
      {user.status === 'suspended' && (
        <Notice tone="warn" className="mt-4">
          This account is suspended, so the hosted services are paused. You can still see your account, and Sync keeps working.
        </Notice>
      )}
      <div className="mt-6">
        {usage.loading && !usage.data ? (
          <p className="text-small text-ink-3" role="status">
            Loading usage…
          </p>
        ) : usage.error ? (
          <Notice tone="danger">
            {errorText(usage.error)}{' '}
            <button type="button" className="text-accent-ink underline" onClick={usage.reload}>
              Try again
            </button>
          </Notice>
        ) : usage.data ? (
          <div className="grid gap-5">
            {MONTHLY.map((m) => {
              const metric = usage.data!.metrics[m.key]
              return metric ? <Meter key={m.key} label={m.label} unit={m.unit} used={metric.used} limit={metric.limit} /> : null
            })}
            {reset && (
              <p className="text-small text-ink-3">
                This month&rsquo;s counts reset on <time dateTime={reset.toISOString()}>{formatResetDay(reset)}</time> (00:00 UTC).
              </p>
            )}
          </div>
        ) : null}
      </div>
    </AccountSection>
  )
}

/* ------------------------------------------------------------------ devices */

export function DevicesSection() {
  const devices = useLoad(api.devices)
  const list = devices.data ?? []
  return (
    <AccountSection
      id="devices"
      title="Kimochi apps"
      description="Copies of Kimochi signed in to this account. Signing one out here takes effect the next time it connects."
    >
      {devices.loading && !devices.data ? (
        <p className="text-small text-ink-3" role="status">
          Loading…
        </p>
      ) : devices.error ? (
        <Notice tone="danger">{errorText(devices.error)}</Notice>
      ) : list.length === 0 ? (
        <p className="text-ink-2">
          No apps are signed in. In Kimochi, open Settings &rarr; Account and choose Sign in to link one.
        </p>
      ) : (
        <ul className="divide-y divide-hairline rounded-lg shadow-[inset_0_0_0_1px_var(--k-line)]">
          {list.map((d) => (
            <li key={d.id} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <div className="flex min-w-0 gap-3">
                <Laptop size={16} aria-hidden className="mt-1 shrink-0 text-ink-3" />
                <div className="min-w-0">
                  <p className="font-medium text-ink break-words">{d.name || 'Kimochi'}</p>
                  <p className="text-small text-ink-2">
                    {platformLabel(d.platform)} · Linked {formatDay(d.createdAt)}
                  </p>
                  {d.lastUsedAt && <p className="text-small text-ink-3">Last used {relativeTime(d.lastUsedAt)}</p>}
                </div>
              </div>
              <ConfirmButton
                label="Sign out"
                question={<>Sign out Kimochi on &ldquo;{d.name || 'this device'}&rdquo;?</>}
                confirmLabel="Sign it out"
                busyLabel="Signing out…"
                onConfirm={async () => {
                  await api.revokeDevice(d.id)
                  devices.setData(list.filter((x) => x.id !== d.id))
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </AccountSection>
  )
}

/* ------------------------------------------------------------------ sign-in methods */

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'discord', label: 'Discord' }
]

function PasswordForm({ user, onDone }: { user: User; onDone: (saved?: string) => void }) {
  const { refresh } = useSession()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [errors, setErrors] = useState<{ current?: string; next?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const errs = {
      current: user.hasPassword && !current ? 'Enter your current password.' : undefined,
      next: passwordProblem(next)
    }
    setErrors(errs)
    setFormError(null)
    if (errs.current || errs.next) return
    setBusy(true)
    try {
      await api.changePassword(user.hasPassword ? { currentPassword: current, newPassword: next } : { newPassword: next })
      const had = user.hasPassword
      await refresh()
      onDone(had ? 'Password changed.' : 'Password set. You can now sign in with your email.')
    } catch (err) {
      setBusy(false)
      if (err instanceof ApiError && err.code === 'unauthorized') setErrors({ current: 'That isn’t your current password.' })
      else setFormError(errorText(err))
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-4 grid gap-4">
      <input type="text" name="username" autoComplete="username" hidden readOnly value={user.email ?? ''} />
      {user.hasPassword && (
        <Field
          label="Current password"
          type="password"
          name="current-password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={errors.current}
          disabled={busy}
          autoFocus
        />
      )}
      <Field
        label={user.hasPassword ? 'New password' : 'Password'}
        type="password"
        name="new-password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD}
        maxLength={MAX_PASSWORD}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        error={errors.next}
        hint={errors.next ? undefined : `At least ${MIN_PASSWORD} characters.`}
        disabled={busy}
        autoFocus={!user.hasPassword}
      />
      {formError && <Notice tone="danger">{formError}</Notice>}
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="secondary" busy={busy} busyLabel="Saving…">
          {user.hasPassword ? 'Change password' : 'Set password'}
        </SubmitButton>
        <Button variant="secondary" onClick={() => onDone()} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function SignInMethodsSection({ user }: { user: User }) {
  const { setUser } = useSession()
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const methods = (user.hasPassword ? 1 : 0) + user.providers.length

  return (
    <AccountSection
      id="sign-in"
      title="Sign-in methods"
      description="Ways you can sign in to this account. Keep at least one."
    >
      <ul className="divide-y divide-hairline rounded-lg shadow-[inset_0_0_0_1px_var(--k-line)]">
        <li className="px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium text-ink">Password</p>
              <p className="text-small text-ink-2">
                {user.hasPassword ? 'Sign in with your email and a password.' : 'Not set. Add one to sign in with your email.'}
              </p>
            </div>
            {!editing && (
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(true)
                  setSaved(null)
                }}
                disabled={!user.email}
              >
                {user.hasPassword ? 'Change' : 'Set a password'}
              </Button>
            )}
          </div>
          {editing && (
            <PasswordForm
              user={user}
              onDone={(msg) => {
                setEditing(false)
                setSaved(msg ?? null)
              }}
            />
          )}
          {saved && <div className="mt-3"><StatusLine>{saved}</StatusLine></div>}
        </li>
        {PROVIDERS.map((p) => {
          const linked = user.providers.includes(p.id)
          const last = linked && methods <= 1
          return (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium text-ink">
                  {p.label} {linked && <Badge tone="ok">Connected</Badge>}
                </p>
                <p className="text-small text-ink-2">
                  {linked
                    ? last
                      ? 'This is your only way to sign in. Set a password or connect another option before disconnecting it.'
                      : `You can sign in with your ${p.label} account.`
                    : `Connect your ${p.label} account to sign in with it.`}
                </p>
              </div>
              {linked ? (
                <ConfirmButton
                  label="Disconnect"
                  question={<>Disconnect {p.label}? You won&rsquo;t be able to sign in with it until you connect it again.</>}
                  confirmLabel="Disconnect"
                  busyLabel="Disconnecting…"
                  disabled={last}
                  onConfirm={async () => {
                    await api.unlinkProvider(p.id)
                    setUser({ ...user, providers: user.providers.filter((x) => x !== p.id) })
                  }}
                />
              ) : (
                <a href={oauthStartUrl(p.id, '/account')} className={buttonClass('secondary', 'md')}>
                  Connect
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </AccountSection>
  )
}

/* ------------------------------------------------------------------ sync */

export function SyncSection() {
  const sync = useLoad(api.sync)
  const data = sync.data
  const sessions = data?.sessions ?? []
  return (
    <AccountSection
      id="sync"
      title="Sync"
      description="While you're signed in, Kimochi keeps your sessions, notebook, presets and preferences in sync between your computers. Everything also stays on each computer."
    >
      {sync.loading && !data ? (
        <p className="text-small text-ink-3" role="status">
          Loading…
        </p>
      ) : sync.error ? (
        <Notice tone="danger">{errorText(sync.error)}</Notice>
      ) : data ? (
        <div className="grid gap-6">
          <Meter label="Storage" used={data.used} limit={data.limit} format={formatStorage} />
          {data.records === 0 ? (
            <p className="text-ink-2">Nothing has synced yet. Sign in in Kimochi (Settings → Account) to start.</p>
          ) : (
            <div>
              <h3 className="text-small font-medium text-ink">
                Synced sessions <span className="text-ink-3 tnum">({sessions.length})</span>
              </h3>
              {sessions.length > 0 && (
                <ul className="mt-2 divide-y divide-hairline rounded-lg shadow-[inset_0_0_0_1px_var(--k-line)]">
                  {sessions.map((s) => (
                    <li key={s.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-small">
                      <span className="min-w-0 text-ink break-words">{s.name || 'Untitled session'}</span>
                      <span className="shrink-0 text-ink-3 tnum">
                        {s.lineCount.toLocaleString('en-US')} {s.lineCount === 1 ? 'line' : 'lines'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <a href={EXPORT_URL} download className={buttonClass('secondary', 'md')}>
              Download all my data
            </a>
            <span className="text-small text-ink-3">A ZIP of plain JSON files and your notebook images.</span>
          </div>
          {data.records > 0 && (
            <ConfirmButton
              label="Delete synced data"
              question="Delete everything Kimochi has synced from its servers? The copies on your computers are not touched, and signed-in computers send theirs again when they next sync."
              confirmLabel="Delete synced data"
              busyLabel="Deleting…"
              onConfirm={async () => {
                await api.deleteSync()
                sync.reload()
              }}
            />
          )}
        </div>
      ) : null}
    </AccountSection>
  )
}

/* ------------------------------------------------------------------ danger zone */

export function DeleteAccountSection({ user }: { user: User }) {
  const navigate = useNavigate()
  const { setUser } = useSession()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ok = deleteConfirmMatches(typed, user.email)

  const onDelete = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      if (!ok) return
      setBusy(true)
      setError(null)
      try {
        await api.deleteAccount(user.email ? typed.trim() : 'delete')
        navigate('/account/sign-in', {
          replace: true,
          state: { notice: 'Your account and everything stored with it have been deleted.' }
        })
        setUser(null)
      } catch (err) {
        setBusy(false)
        setError(errorText(err))
      }
    },
    [ok, typed, user.email, navigate, setUser]
  )

  return (
    <AccountSection
      id="delete"
      title="Delete account"
      description="Removes your account, usage history and everything synced, and signs out every linked app. This can’t be undone."
    >
      <form onSubmit={onDelete} className="grid gap-3">
        <Field
          label={user.email ? <>Type <span className="break-all">{user.email}</span> to confirm</> : <>Type &ldquo;delete&rdquo; to confirm</>}
          name="confirm-delete"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={busy}
        />
        {error && <Notice tone="danger">{error}</Notice>}
        <div>
          <SubmitButton variant="secondary" className={dangerButtonExtra} busy={busy} busyLabel="Deleting…" disabled={!ok}>
            Delete my account
          </SubmitButton>
        </div>
      </form>
    </AccountSection>
  )
}
