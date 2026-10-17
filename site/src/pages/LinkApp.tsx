import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { LoaderCircle } from 'lucide-react'
import { AuthShell } from '../components/account/AuthShell'
import { Field } from '../components/account/Field'
import { Notice } from '../components/account/Notice'
import { SubmitButton } from '../components/account/SubmitButton'
import { Button } from '../components/Button'
import { api, ApiError, signInUrl, type LinkRequest } from '../lib/api'
import { formatCodeInput, messageForCode, normalizeLinkCode, platformLabel, relativeTime } from '../lib/account.js'
import { useSession } from '../lib/session'

/** The custom URL scheme the app registers; opens Settings → Account. */
const OPEN_APP_URL = 'kimochi://account'

type View =
  | { kind: 'loading' }
  | { kind: 'confirm'; request: LinkRequest }
  | { kind: 'approved' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }

function CodeForm({ initial = '', error: initialError }: { initial?: string; error?: string }) {
  const [, setParams] = useSearchParams()
  const [value, setValue] = useState(formatCodeInput(initial))
  const [error, setError] = useState<string | undefined>(initialError)
  const input = useRef<HTMLInputElement>(null)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const code = normalizeLinkCode(value)
    if (!code) {
      setError('Enter the 8-character code Kimochi shows, like ABCD-EFGH.')
      input.current?.focus()
      return
    }
    setParams({ code })
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4">
      <Field
        ref={input}
        label="Code from Kimochi"
        name="code"
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        placeholder="ABCD-EFGH"
        inputClassName="h-12 font-mono text-[1.375rem] tracking-[0.12em] uppercase"
        value={value}
        maxLength={12}
        onChange={(e) => {
          setValue(formatCodeInput(e.target.value))
          setError(undefined)
        }}
        error={error}
        hint={error ? undefined : 'Kimochi shows it in Settings → Account after you choose Sign in.'}
      />
      <SubmitButton busy={false} busyLabel="" className="h-11 w-full">
        Continue
      </SubmitButton>
    </form>
  )
}

function CodeDisplay({ code }: { code: string }) {
  return (
    <div className="rounded-xl bg-sunken px-4 py-6 text-center shadow-[inset_0_0_0_1px_var(--k-line)]">
      <p className="text-meta text-ink-3">Code</p>
      <p className="mt-1 font-mono text-[clamp(2rem,1.2rem+4vw,3rem)] leading-tight font-semibold tracking-[0.12em] text-ink tnum">
        {code}
      </p>
    </div>
  )
}

export function LinkApp() {
  const [params] = useSearchParams()
  const raw = params.get('code')
  const code = normalizeLinkCode(raw)
  const { status, user } = useSession()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!code || status !== 'signed-in') return
    let live = true
    setView({ kind: 'loading' })
    setActionError(null)
    api.linkRequest(code).then(
      (request) => {
        if (!live) return
        if (request.status === 'pending') setView({ kind: 'confirm', request })
        else setView({ kind: request.status } as View)
      },
      (err: unknown) => {
        if (!live) return
        if (err instanceof ApiError && err.code === 'not_found') setView({ kind: 'expired' })
        else setView({ kind: 'error', message: err instanceof ApiError ? err.message : messageForCode('internal') })
      }
    )
    return () => {
      live = false
    }
  }, [code, status])

  // No code, or one that isn't a code: let the person type it.
  if (!code) {
    return (
      <AuthShell
        title="Sign in to Kimochi"
        lede={<p>Enter the code shown in the Kimochi app to sign it in to your account.</p>}
      >
        <CodeForm
          key={raw ?? ''}
          initial={raw ?? ''}
          error={raw ? 'That doesn’t look like a Kimochi code. It has 8 letters and numbers, like ABCD-EFGH.' : undefined}
        />
      </AuthShell>
    )
  }

  // Canonicalise the URL (abcd efgh → ABCD-EFGH) so sign-in returns to a clean link.
  if (raw !== code) return <Navigate to={`/link?code=${code}`} replace />

  if (status === 'loading') {
    return (
      <AuthShell title="Sign in to Kimochi">
        <p className="flex items-center gap-2 text-ink-2" role="status">
          <LoaderCircle size={16} aria-hidden className="motion-safe:animate-spin" /> One moment.
        </p>
      </AuthShell>
    )
  }

  if (status === 'signed-out') return <Navigate to={signInUrl(`/link?code=${code}`)} replace />

  if (view.kind === 'approved') {
    return (
      <AuthShell title="Kimochi is signed in" lede={<p>You can go back to the app.</p>}>
        <Button href={OPEN_APP_URL} size="lg">
          Open Kimochi
        </Button>
        <p className="mt-6 text-small text-ink-3">
          You can see and sign out linked apps on <Link to="/account#devices" className="text-accent-ink">your account page</Link>.
        </p>
      </AuthShell>
    )
  }

  if (view.kind === 'denied') {
    return (
      <AuthShell title="Request denied" lede={<p>Kimochi was not signed in. If you didn&rsquo;t start this, you don&rsquo;t need to do anything else.</p>}>
        <p className="text-small text-ink-2">
          To try again, choose Sign in in Kimochi&rsquo;s Settings &rarr; Account for a new code.
        </p>
      </AuthShell>
    )
  }

  if (view.kind === 'expired') {
    return (
      <AuthShell
        title="This code has expired"
        lede={
          <p>
            Codes work for 10 minutes, once. In Kimochi, choose Sign in again (Settings &rarr; Account) for a new code,
            then enter it here.
          </p>
        }
      >
        <CodeForm key="expired" />
      </AuthShell>
    )
  }

  if (view.kind === 'error') {
    return (
      <AuthShell title="Sign in to Kimochi">
        <Notice tone="danger">{view.message}</Notice>
        <Button variant="secondary" className="mt-6" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </AuthShell>
    )
  }

  if (view.kind === 'loading') {
    return (
      <AuthShell title="Sign in to Kimochi">
        <CodeDisplay code={code} />
        <p className="mt-6 flex items-center gap-2 text-ink-2" role="status">
          <LoaderCircle size={16} aria-hidden className="motion-safe:animate-spin" /> Checking the code…
        </p>
      </AuthShell>
    )
  }

  const { request } = view

  async function act(kind: 'approve' | 'deny') {
    setBusy(kind)
    setActionError(null)
    try {
      await (kind === 'approve' ? api.approveLink(code!) : api.denyLink(code!))
      setView({ kind: kind === 'approve' ? 'approved' : 'denied' })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_found') setView({ kind: 'expired' })
      else setActionError(err instanceof ApiError ? err.message : messageForCode('internal'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <AuthShell
      title="Does this match the code in Kimochi?"
      lede={<p>Only approve if you just chose Sign in in Kimochi and it shows this exact code.</p>}
    >
      <CodeDisplay code={request.code || code} />
      <dl className="mt-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-small">
        <dt className="text-ink-3">Device</dt>
        <dd className="text-ink break-words">{request.deviceName || 'Kimochi'}</dd>
        <dt className="text-ink-3">Platform</dt>
        <dd className="text-ink">{platformLabel(request.platform)}</dd>
        {request.createdAt && (
          <>
            <dt className="text-ink-3">Requested</dt>
            <dd className="text-ink">{relativeTime(request.createdAt)}</dd>
          </>
        )}
        <dt className="text-ink-3">Account</dt>
        <dd className="text-ink break-all">{user?.email ?? user?.displayName ?? 'You'}</dd>
      </dl>
      {actionError && (
        <Notice tone="danger" className="mt-6">
          {actionError}
        </Notice>
      )}
      <div className="mt-8 flex flex-col gap-2.5 sm:flex-row">
        <SubmitButton
          type="button"
          busy={busy === 'approve'}
          busyLabel="Approving…"
          disabled={busy !== null}
          onClick={() => act('approve')}
          className="h-11 sm:flex-1"
        >
          Yes, sign in Kimochi
        </SubmitButton>
        <SubmitButton
          type="button"
          variant="secondary"
          busy={busy === 'deny'}
          busyLabel="Denying…"
          disabled={busy !== null}
          onClick={() => act('deny')}
          className="h-11 sm:flex-1"
        >
          No, deny
        </SubmitButton>
      </div>
    </AuthShell>
  )
}
