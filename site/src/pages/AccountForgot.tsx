import { useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AuthShell } from '../components/account/AuthShell'
import { Field } from '../components/account/Field'
import { Notice } from '../components/account/Notice'
import { SubmitButton } from '../components/account/SubmitButton'
import { api, ApiError } from '../lib/api'
import { messageForCode, safeReturnTo } from '../lib/account.js'
import { withReturnTo } from './AccountSignIn'

export function AccountForgot() {
  const [params] = useSearchParams()
  const returnTo = safeReturnTo(params.get('returnTo'))
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError('Enter the email address you signed up with.')
      emailRef.current?.focus()
      return
    }
    setError(null)
    setBusy(true)
    try {
      await api.forgotPassword(email.trim())
      setSentTo(email.trim())
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : messageForCode('internal'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      lede={<p>Enter your email and we&rsquo;ll send you a link to choose a new password.</p>}
      footer={
        <p>
          Remembered it?{' '}
          <Link to={withReturnTo('/account/sign-in', returnTo)} className="text-accent-ink">
            Back to sign in
          </Link>
        </p>
      }
    >
      {sentTo ? (
        <Notice tone="ok">
          If an account uses <strong className="font-medium break-all">{sentTo}</strong>, a reset link is on its way.
          It works for one hour. Check your spam folder if it doesn&rsquo;t arrive in a few minutes.
        </Notice>
      ) : (
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
            error={error}
            disabled={busy}
          />
          {formError && <Notice tone="danger">{formError}</Notice>}
          <SubmitButton busy={busy} busyLabel="Sending…" className="mt-1 h-11 w-full">
            Send reset link
          </SubmitButton>
        </form>
      )}
    </AuthShell>
  )
}
