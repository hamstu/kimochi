import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { AuthShell } from '../components/account/AuthShell'
import { Field } from '../components/account/Field'
import { Notice } from '../components/account/Notice'
import { SubmitButton } from '../components/account/SubmitButton'
import { api, ApiError } from '../lib/api'
import { messageForCode } from '../lib/account.js'
import { useSession } from '../lib/session'
import { MAX_PASSWORD, MIN_PASSWORD, passwordProblem } from './AccountSignUp'

export function AccountReset() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()
  const { setUser } = useSession()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({})
  const [busy, setBusy] = useState(false)
  const [expired, setExpired] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const pwRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const errs = {
      password: passwordProblem(password),
      confirm: password && confirm !== password ? 'The two passwords don’t match.' : undefined
    }
    setErrors(errs)
    setFormError(null)
    if (errs.password) return pwRef.current?.focus()
    if (errs.confirm) return confirmRef.current?.focus()
    setBusy(true)
    try {
      const u = await api.resetPassword(token, password)
      setUser(u)
      navigate('/account', {
        replace: true,
        state: { notice: 'Your password is changed and you’re signed in. Other browsers and linked apps were signed out.' }
      })
    } catch (err) {
      setBusy(false)
      if (err instanceof ApiError && (err.code === 'invalid' || err.code === 'not_found' || err.code === 'unauthorized')) {
        setExpired(true)
      } else {
        setFormError(err instanceof ApiError ? err.message : messageForCode('internal'))
      }
    }
  }

  if (!token || expired) {
    return (
      <AuthShell title="This link has expired">
        <p className="text-ink-2">
          Password reset links work once, for one hour. Ask for a new one and use the latest email.
        </p>
        <Link to="/account/forgot" className="mt-6 inline-block text-accent-ink">
          Send a new reset link
        </Link>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Choose a new password"
      lede={<p>This signs you out everywhere else, including Kimochi apps linked to your account.</p>}
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        {/* Lets password managers attach the new password to the right account. */}
        <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
        <Field
          ref={pwRef}
          label="New password"
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
        <Field
          ref={confirmRef}
          label="Confirm new password"
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
          disabled={busy}
        />
        {formError && <Notice tone="danger">{formError}</Notice>}
        <SubmitButton busy={busy} busyLabel="Saving…" className="mt-1 h-11 w-full">
          Save new password
        </SubmitButton>
      </form>
    </AuthShell>
  )
}
