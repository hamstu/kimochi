import { buttonClass } from '../Button'
import { oauthStartUrl, type Provider } from '../../lib/api'

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'discord', label: 'Discord' }
]

/**
 * "Continue with Google / Discord". Plain <a> elements on purpose: these leave the single-page
 * app for the server's OAuth redirect, so a router Link would be wrong.
 */
export function OAuthButtons({ returnTo }: { returnTo: string }) {
  return (
    <div className="grid gap-2.5">
      {PROVIDERS.map((p) => (
        <a key={p.id} href={oauthStartUrl(p.id, returnTo)} className={buttonClass('secondary', 'lg', 'w-full')}>
          Continue with {p.label}
        </a>
      ))}
    </div>
  )
}

export function OrDivider() {
  return (
    <div className="my-6 flex items-center gap-3 text-meta text-ink-3" aria-hidden>
      <span className="h-px flex-1 bg-hairline" />
      or
      <span className="h-px flex-1 bg-hairline" />
    </div>
  )
}

/** What an account is for. Shown on sign-in and sign-up. */
export function AccountPitch() {
  return (
    <p>
      Accounts are optional: Kimochi works fully without one. An account is where Kimochi Cloud lives:
      cloud OCR, read aloud, translation, AI explanations and Sync, with a 14-day free trial.
    </p>
  )
}
