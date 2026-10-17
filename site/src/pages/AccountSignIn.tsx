import { useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { AuthShell } from '../components/account/AuthShell'
import { Field } from '../components/account/Field'
import { Notice } from '../components/account/Notice'
import { SubmitButton } from '../components/account/SubmitButton'
import { AccountPitch, OAuthButtons, OrDivider } from '../components/account/OAuthButtons'
import { Button } from '../components/Button'
import { api, ApiError } from '../lib/api'
import { messageForCode, safeReturnTo } from '../lib/account.js'
import { useSession } from '../lib/session'

/** Carry returnTo onto sibling auth pages (sign-up, forgot) so the person still ends up there. */
export function withReturnTo(path: string, returnTo: string): string {
  return returnTo === '/account' ? path : `${path}?returnTo=${encodeURIComponent(returnTo)}`
}

export function AccountSignIn() {
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { status, user, setUser, unreachable } = useSession()
  const returnTo = safeReturnTo(params.get('returnTo'))
  const errorCode = params.get('error')
  const notice = (location.state as { notice?: string } | null)?.notice

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({})
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // Already signed in: go on, unless an OAuth error needs showing (e.g. a failed link attempt).
  if (status === 'signed-in' && !errorCode) return <Navigate to={returnTo} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const errs: typeof fieldErrors = {}
    if (!email.trim()) errs.email = 'Enter your email address.'
    if (!password) errs.password = 'Enter your password.'
    setFieldErrors(errs)
    setFormError(null)
    if (errs.email) return emailRef.current?.focus()
    if (errs.password) return passwordRef.current?.focus()
    setBusy(true)
    try {
      const u = await api.signIn({ email: email.trim(), password })
      setUser(u)
      navigate(returnTo, { replace: true })
    } catch (err) {
      const msg =
        err instanceof ApiError && err.code === 'unauthorized'
          ? 'That email and password don’t match an account. Check them and try again.'
          : err instanceof ApiError
            ? err.message
            : messageForCode('internal')
      setFormError(msg)
      setBusy(false)
      passwordRef.current?.select()
    }
  }

  return (
    <AuthShell
      title="Sign in to Kimochi"
      lede={<AccountPitch />}
      footer={
        <p>
          New here? <Link to={withReturnTo('/account/sign-up', returnTo)} className="text-accent-ink">Create an account</Link>
        </p>
      }
    >
      {notice && !errorCode && <Notice tone="ok" className="mb-6">{notice}</Notice>}
      {errorCode && (
        <Notice tone="danger" className="mb-6">
          {messageForCode(errorCode)}
          {status === 'signed-in' && (
            <>
              {' '}
              <Link to="/account">Back to your account</Link>
            </>
          )}
        </Notice>
      )}
      {unreachable && !errorCode && <Notice tone="warn" className="mb-6">{messageForCode('network')}</Notice>}

      {status === 'signed-in' && user ? (
        <Button href="/account" variant="secondary">
          Back to your account
        </Button>
      ) : (
        <>
          <OAuthButtons returnTo={returnTo} />
          <OrDivider />
          <form onSubmit={onSubmit} noValidate className="grid gap-4">
            <Field
              ref={emailRef}
              label="Email"
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
              disabled={busy}
            />
            <div>
              <Field
                ref={passwordRef}
                label="Password"
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={fieldErrors.password}
                disabled={busy}
              />
              <p className="mt-2 text-small">
                <Link to={withReturnTo('/account/forgot', returnTo)} className="text-accent-ink">
                  Forgot your password?
                </Link>
              </p>
            </div>
            {formError && <Notice tone="danger">{formError}</Notice>}
            <SubmitButton busy={busy} busyLabel="Signing in…" className="mt-1 h-11 w-full">
              Sign in
            </SubmitButton>
          </form>
        </>
      )}
    </AuthShell>
  )
}
