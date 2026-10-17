import { useEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { LogOut } from 'lucide-react'
import { Notice } from '../components/account/Notice'
import { SubmitButton } from '../components/account/SubmitButton'
import {
  SyncSection,
  DeleteAccountSection,
  DevicesSection,
  ProfileSection,
  SignInMethodsSection,
  UsageSection
} from '../components/account/sections'
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

export function Account() {
  const { status, user, unreachable } = useSession()
  const location = useLocation()
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
          <SignOutButton />
        </header>
        {notice && (
          <Notice tone="ok" className="mb-10">
            {notice}
          </Notice>
        )}
        <ProfileSection user={user} />
        <UsageSection user={user} />
        <DevicesSection />
        <SignInMethodsSection user={user} />
        <SyncSection />
        <DeleteAccountSection user={user} />
      </div>
    </div>
  )
}
