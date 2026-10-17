import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { LoaderCircle } from 'lucide-react'
import { AuthShell } from '../components/account/AuthShell'
import { Notice } from '../components/account/Notice'
import { SubmitButton } from '../components/account/SubmitButton'
import { Button } from '../components/Button'
import { api, ApiError } from '../lib/api'
import { messageForCode } from '../lib/account.js'
import { useSession } from '../lib/session'

type State = { kind: 'working' } | { kind: 'done' } | { kind: 'failed'; message: string; expired: boolean }

export function AccountVerify() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const { status, setUser } = useSession()
  const [state, setState] = useState<State>(() =>
    token ? { kind: 'working' } : { kind: 'failed', message: 'This link is missing its code.', expired: true }
  )
  const [resend, setResend] = useState<'idle' | 'busy' | 'sent' | string>('idle')
  // Tokens are single use; StrictMode runs effects twice in development, so guard with a ref.
  const started = useRef(false)

  useEffect(() => {
    if (!token || started.current) return
    started.current = true
    api
      .verifyEmail(token)
      .then((u) => {
        setUser(u)
        setState({ kind: 'done' })
      })
      .catch((err: unknown) => {
        const expired = err instanceof ApiError && ['invalid', 'not_found', 'unauthorized'].includes(err.code)
        setState({
          kind: 'failed',
          expired,
          message: expired
            ? 'This link has expired or was already used. Verification links work once, for 24 hours.'
            : err instanceof ApiError
              ? err.message
              : messageForCode('internal')
        })
      })
  }, [token, setUser])

  async function onResend() {
    setResend('busy')
    try {
      await api.resendVerification()
      setResend('sent')
    } catch (err) {
      setResend(err instanceof ApiError ? err.message : messageForCode('internal'))
    }
  }

  if (state.kind === 'working') {
    return (
      <AuthShell title="Confirming your email…">
        <p className="flex items-center gap-2 text-ink-2" role="status">
          <LoaderCircle size={16} aria-hidden className="motion-safe:animate-spin" /> One moment.
        </p>
      </AuthShell>
    )
  }

  if (state.kind === 'done') {
    return (
      <AuthShell title="Email confirmed" lede={<p>Thanks. Your email address is verified.</p>}>
        <Button href="/account">Go to your account</Button>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="We couldn’t confirm your email">
      <Notice tone="danger">{state.message}</Notice>
      <div className="mt-6">
        {status === 'signed-in' ? (
          resend === 'sent' ? (
            <Notice tone="ok">A new link is on its way. Check your inbox.</Notice>
          ) : (
            <>
              <SubmitButton type="button" busy={resend === 'busy'} busyLabel="Sending…" onClick={onResend}>
                Send a new link
              </SubmitButton>
              {resend !== 'idle' && resend !== 'busy' && <p className="mt-3 text-small text-danger">{resend}</p>}
            </>
          )
        ) : (
          <p className="text-ink-2">
            Sign in and use &ldquo;Resend&rdquo; next to your email on the account page to get a new link.
          </p>
        )}
        {status !== 'signed-in' && (
          <Button href="/account/sign-in" className="mt-6">
            Sign in
          </Button>
        )}
      </div>
    </AuthShell>
  )
}
