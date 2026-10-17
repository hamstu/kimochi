import { useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { AuthShell } from '../components/account/AuthShell'
import { Field } from '../components/account/Field'
import { Notice } from '../components/account/Notice'
import { SubmitButton } from '../components/account/SubmitButton'
import { AccountPitch, OAuthButtons, OrDivider } from '../components/account/OAuthButtons'
import { api, ApiError } from '../lib/api'
import { messageForCode, safeReturnTo } from '../lib/account.js'
import { useSession } from '../lib/session'
import { withReturnTo } from './AccountSignIn'

export const MIN_PASSWORD = 10
export const MAX_PASSWORD = 200

/** Client-side password check matching the server's rule (10–200 characters). */
export function passwordProblem(pw: string): string | undefined {
  if (!pw) return 'Choose a password.'
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  if (pw.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`
  return undefined
}

export function AccountSignUp() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { status, setUser } = useSession()
  const returnTo = safeReturnTo(params.get('returnTo'))

  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  if (status === 'signed-in' && !busy) return <Navigate to={returnTo} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const errs: typeof errors = {}
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) errs.email = 'Enter a valid email address.'
    errs.password = passwordProblem(password)
    setErrors(errs)
    setFormError(null)
    if (errs.email) return emailRef.current?.focus()
    if (errs.password) return passwordRef.current?.focus()
    setBusy(true)
    try {
      const u = await api.signUp({ email: email.trim(), password, displayName: displayName.trim() || undefined })
      setUser(u)
      navigate(returnTo, {
        replace: true,
        state: { notice: `Welcome to Kimochi. We sent a link to ${u.email ?? 'your email'} to confirm the address.` }
      })
    } catch (err) {
      setBusy(false)
      if (err instanceof ApiError && err.code === 'conflict') {
        setErrors({ email: 'There is already an account with this email. Sign in instead, or reset the password.' })
        emailRef.current?.focus()
      } else {
        setFormError(err instanceof ApiError ? err.message : messageForCode('internal'))
      }
    }
  }

  return (
    <AuthShell
      title="Create an account"
      lede={<AccountPitch />}
      footer={
        <p>
          Already have an account?{' '}
          <Link to={withReturnTo('/account/sign-in', returnTo)} className="text-accent-ink">
            Sign in
          </Link>
        </p>
      }
    >
      <OAuthButtons returnTo={returnTo} />
      <OrDivider />
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        <Field
          label="Name (optional)"
          name="name"
          autoComplete="nickname"
          value={displayName}
          maxLength={80}
          onChange={(e) => setDisplayName(e.target.value)}
          hint="How Kimochi greets you. You can change it later."
          disabled={busy}
        />
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
          error={errors.email}
          disabled={busy}
        />
        <Field
          ref={passwordRef}
          label="Password"
          type="password"
          name="new-password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          maxLength={MAX_PASSWORD}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint={errors.password ? undefined : `At least ${MIN_PASSWORD} characters.`}
          disabled={busy}
        />
        {formError && <Notice tone="danger">{formError}</Notice>}
        <SubmitButton busy={busy} busyLabel="Creating account…" className="mt-1 h-11 w-full">
          Create account
        </SubmitButton>
        <p className="text-small text-ink-3">
          By creating an account you agree to the <Link to="/terms" className="text-accent-ink">terms</Link>. The{' '}
          <Link to="/privacy#accounts" className="text-accent-ink">privacy page</Link> lists what an account stores.
        </p>
      </form>
    </AuthShell>
  )
}
