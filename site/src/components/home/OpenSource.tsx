import { useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { GITHUB_URL } from '../Layout'
import { Button } from '../Button'
import { useSession } from '../../lib/session'
import { ApiError, type Choice } from '../../lib/api'
import { messageForCode } from '../../lib/account.js'
import { CHOICES, PRICES, TRIAL_DAYS, checkoutPath, ctaLabel, goToCheckout } from '../../lib/billing'

/** Everything in Kimochi itself: free, no account, no limits. */
const FREE = [
  'The overlay, Auto OCR and Mini mode',
  'On-device and online OCR engines',
  'The Log, Sessions and the Notebook',
  'Yomitan, Hachidori, 10ten or your own Yomitan',
  'Anki cards in one click',
  'Gaming Mode on the Steam Deck'
]

/** What an account's paid plan adds: the parts that cost money to run. */
const CLOUD = [
  'Translation of any line, right in the app',
  'On-demand AI Explanations ✨',
  'Read aloud in high-quality ElevenLabs voices',
  'Cloud OCR with Google Vision',
  'Sync of your logs and notebook across devices'
]

/** Monthly / Yearly / Lifetime, as a small segmented control. */
export function PlanToggle({ value, onChange }: { value: Choice; onChange: (choice: Choice) => void }) {
  return (
    <div role="radiogroup" aria-label="Billing" className="inline-flex rounded-full bg-[color-mix(in_oklab,var(--k-ink)_6%,transparent)] p-0.5">
      {CHOICES.map((choice) => (
        <button
          key={choice}
          type="button"
          role="radio"
          aria-checked={value === choice}
          onClick={() => onChange(choice)}
          className={`rounded-full px-2.5 py-1 text-meta transition-colors duration-100 ${
            value === choice ? 'bg-raised text-ink shadow-[0_0_0_1px_var(--k-line)]' : 'text-ink-2 hover:text-ink'
          }`}
        >
          {PRICES[choice].label}
        </button>
      ))}
    </div>
  )
}

/** The line under the call to action: what the trial or purchase means. */
export function fineprint(choice: Choice, trial: boolean): string {
  if (choice === 'lifetime') return 'One payment, no subscription.'
  const then = choice === 'yearly' ? '$60 a year' : '$6 a month'
  return trial ? `Free for ${TRIAL_DAYS} days, then ${then}. Cancel before then and you pay nothing.` : `${then}. Cancel any time.`
}

/**
 * The call to action: signed out, create an account and go on to checkout; signed in, straight to
 * Stripe Checkout; already on Kimochi Cloud, the account page.
 */
function CloudAction({ choice }: { choice: Choice }) {
  const { status, user } = useSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (status === 'signed-in' && user?.cloud) {
    return (
      <Button href="/account" size="lg">
        Manage your plan
      </Button>
    )
  }
  const trial = status !== 'signed-in' || !!user?.billing.trialAvailable
  const label = ctaLabel(choice, trial)
  return (
    <div className="grid gap-2">
      {status === 'signed-in' ? (
        <Button
          size="lg"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await goToCheckout(choice, 'home')
            } catch (err) {
              setBusy(false)
              setError(err instanceof ApiError ? err.message : messageForCode('internal'))
            }
          }}
        >
          {busy ? 'Opening checkout…' : label}
        </Button>
      ) : (
        <Button href={`/account/sign-up?returnTo=${encodeURIComponent(checkoutPath(choice))}`} size="lg">
          {label}
        </Button>
      )}
      <span className="text-small text-ink-3">{fineprint(choice, trial)}</span>
      {error && (
        <span role="alert" className="text-small text-danger">
          {error}
        </span>
      )}
    </div>
  )
}

/**
 * Free and open source: the GPL licence, and the optional paid plan side by side with what is free,
 * so it is plain the plan is extra.
 */
export function OpenSource() {
  const [choice, setChoice] = useState<Choice>('yearly')
  const price = PRICES[choice]
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="flex flex-col rounded-2xl border border-hairline bg-raised p-6 md:p-8">
        <p className="text-meta tracking-[0.08em] text-ink-3 uppercase">Kimochi</p>
        <p className="mt-3 flex items-baseline gap-2">
          <span className="text-[2.5rem] leading-none font-semibold tracking-[-0.02em] text-ink">Free</span>
          <span className="text-small text-ink-3">forever</span>
        </p>
        <p className="mt-3 text-body text-ink-2">Everything you need to read your games. No account, no limits.</p>
        <ul className="mt-6 flex flex-col gap-2.5">
          {FREE.map((item) => (
            <li key={item} className="flex gap-2.5 text-body text-ink">
              <Check size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
        <a
          href={GITHUB_URL}
          className="mt-auto pt-7 text-small text-ink-3 underline decoration-hairline underline-offset-4 hover:text-ink-2 hover:decoration-current"
        >
          Source on GitHub, under the GPL-3.0 licence
        </a>
      </div>

      <div className="relative flex flex-col overflow-hidden rounded-2xl border border-[color-mix(in_oklab,var(--k-accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--k-accent)_7%,var(--k-raised))] p-6 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-meta tracking-[0.08em] text-accent-ink uppercase">Kimochi Cloud</p>
          <PlanToggle value={choice} onChange={setChoice} />
        </div>
        <p className="mt-3 flex items-baseline gap-1.5">
          <span className="text-[2.5rem] leading-none font-semibold tracking-[-0.02em] text-ink tnum">{price.amount}</span>
          <span className="text-small text-ink-3">{price.per}</span>
        </p>
        <p className="mt-1.5 text-small text-ink-3" aria-live="polite">
          {price.note}
        </p>
        <p className="mt-3 text-body text-ink-2">Support the cause, and get some cool features.</p>
        <ul className="mt-6 flex flex-col gap-2.5">
          <li className="flex gap-2.5 text-body text-ink-2">
            <Check size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden />
            Everything in Kimochi, of course
          </li>
          {CLOUD.map((item) => (
            <li key={item} className="flex gap-2.5 text-body text-ink">
              <Plus size={18} className="mt-0.5 shrink-0 text-accent-ink" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
        {/* An account can be made here before Kimochi is installed; the app signs in to it later. */}
        <div className="mt-auto pt-7">
          <CloudAction choice={choice} />
        </div>
      </div>
    </div>
  )
}
