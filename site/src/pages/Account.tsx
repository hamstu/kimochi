import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { LogOut, Shield } from 'lucide-react'
import { Notice } from '../components/account/Notice'
import { SubmitButton } from '../components/account/SubmitButton'
import {
  SyncSection,
  DeleteAccountSection,
  DevicesSection,
  ProfileSection,
  SignInMethodsSection
} from '../components/account/sections'
import { PlanSection } from '../components/account/PlanSection'
import { goToCheckout, isChoice } from '../lib/billing'
import { api, ApiError } from '../lib/api'
import { messageForCode } from '../lib/account.js'
import { useSession } from '../lib/session'

function SignOutButton() {
  const navigate = useNavigate()
  const { setUser } = useSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="grid justify-items-start gap-2 sm:justify-items-end">
      <SubmitButton
        type="button"
        variant="secondary"
        busy={busy}
        busyLabel="Signing out…"
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await api.signOut()
            navigate('/account/sign-in', { replace: true, state: { notice: 'You’re signed out of this browser.' } })
            setUser(null)
          } catch (err) {
            setBusy(false)
            setError(err instanceof ApiError ? err.message : messageForCode('internal'))
          }
        }}
      >
        <LogOut size={14} aria-hidden />
        Sign out
      </SubmitButton>
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * Arriving with `?start=<choice>` (the home page's Cloud card, through sign-up) goes straight on to
 * Stripe Checkout. Coming back with `?checkout=<choice>` reads the new plan from Stripe at once, in
 * case its webhook is still on the way; `?checkout=cancelled` says nothing was charged.
 */
function useCheckoutReturn(signedIn: boolean): { tone: 'ok' | 'warn' | 'danger'; text: string } | null {
  const [params, setParams] = useSearchParams()
  const { setUser } = useSession()
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null)
  const start = params.get('start')
  const checkout = params.get('checkout')
  const handled = useRef(false)

  useEffect(() => {
    if (!signedIn || handled.current || (!start && !checkout)) return
    handled.current = true
    if (isChoice(start)) {
      setMessage({ tone: 'ok', text: 'Taking you to checkout…' })
      goToCheckout(start, 'account').catch((err: unknown) => {
        setMessage({ tone: 'danger', text: err instanceof ApiError ? err.message : messageForCode('internal') })
        setParams({}, { replace: true })
      })
      return
    }
    setParams({}, { replace: true })
    if (checkout === 'cancelled') {
      setMessage({ tone: 'warn', text: 'Checkout was cancelled, and nothing was charged.' })
      return
    }
    if (!isChoice(checkout)) return
    setMessage({ tone: 'ok', text: 'Thank you! Setting up Kimochi Cloud…' })
    let tries = 0
    const poll = async () => {
      try {
        const user = await api.billingRefresh()
        if (user.cloud || tries >= 5) {
          setUser(user)
          setMessage(
            user.cloud
              ? { tone: 'ok', text: 'Welcome to Kimochi Cloud! Sign in to the app from Settings → Account and it’s all switched on.' }
              : { tone: 'warn', text: 'Your payment went through, but your plan hasn’t updated yet. It should in a minute; reload this page then.' }
          )
          return
        }
      } catch {
        if (tries >= 5) return
      }
      tries++
      setTimeout(poll, 1500)
    }
    void poll()
  }, [signedIn, start, checkout, setParams, setUser])
  return message
}

export function Account() {
  const { status, user, unreachable } = useSession()
  const location = useLocation()
  const checkoutMessage = useCheckoutReturn(status === 'signed-in')
  const heading = useRef<HTMLHeadingElement>(null)
  const ready = status === 'signed-in'
  // Focus the heading once the account has loaded, so the page is announced after navigation.
  useEffect(() => {
    if (ready) heading.current?.focus({ preventScroll: true })
  }, [ready])
  const notice = (location.state as { notice?: string } | null)?.notice

  if (status === 'signed-out' && unreachable) {
    return (
      <section className="container-page py-14 md:py-20">
        <div className="mx-auto max-w-[26rem]">
          <h1 className="text-title text-ink">Your account</h1>
          <Notice tone="warn" className="mt-6">
            {messageForCode('network')}
          </Notice>
        </div>
      </section>
    )
  }
  if (status === 'signed-out') return <Navigate to="/account/sign-in" replace />
  if (status === 'loading' || !user) {
    return (
      <section className="container-page py-14 md:py-20" aria-busy="true">
        <p className="text-ink-3" role="status">
          Loading your account…
        </p>
      </section>
    )
  }

  const name = user.displayName?.trim()
  return (
    <div className="container-page py-14 md:py-20">
      <div className="mx-auto max-w-[56rem]">
        <header className="flex flex-col gap-5 pb-10 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 ref={heading} tabIndex={-1} className="text-title text-ink outline-none">
              {name ? `Hi, ${name}` : 'Your account'}
            </h1>
            <p className="mt-2 text-ink-2 break-all">{user.email ? `Signed in as ${user.email}` : 'Signed in'}</p>
          </div>
          <div className="flex flex-wrap items-start gap-3 sm:justify-end">
            {user.plan === 'owner' && (
              <Link to="/account/admin" className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-small text-ink-2 hover:bg-hover hover:text-ink">
                <Shield size={14} aria-hidden />
                Admin
              </Link>
            )}
            <SignOutButton />
          </div>
        </header>
        {checkoutMessage && (
          <Notice tone={checkoutMessage.tone} className="mb-10">
            {checkoutMessage.text}
          </Notice>
        )}
        {notice && (
          <Notice tone="ok" className="mb-10">
            {notice}
          </Notice>
        )}
        <ProfileSection user={user} />
        <PlanSection user={user} />
        <DevicesSection />
        <SignInMethodsSection user={user} />
        <SyncSection />
        <DeleteAccountSection user={user} />
      </div>
    </div>
  )
}
