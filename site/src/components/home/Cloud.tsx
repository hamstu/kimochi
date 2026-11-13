import { useState, type ReactNode } from 'react'
import { ArrowRight, AudioLines, Check, Languages, Plus, RefreshCw, ScanText, Sparkles } from 'lucide-react'
import { GITHUB_URL } from '../Layout'
import { Button } from '../Button'
import { useSession } from '../../lib/session'
import { ApiError, type Choice } from '../../lib/api'
import { messageForCode } from '../../lib/account.js'
import { docsUrl } from '../../lib/docs.js'
import { CHOICES, PRICES, PRICE_SUMMARY, TRIAL_DAYS, checkoutPath, ctaLabel, goToCheckout } from '../../lib/billing'

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
  'Translation of any line, in the app',
  'On-demand AI Explanations',
  'Read aloud in ElevenLabs voices',
  'Cloud OCR with Google Vision',
  'Sync of your logs and notebook across devices'
]

/**
 * The same five, with a line each, above the plan cards. Copy follows the docs (cloud/,
 * lookups/translation-and-ai/, reading/ocr-engines/): keep them in step.
 */
const CLOUD_FEATURES: { icon: ReactNode; title: string; body: string; docs: string }[] = [
  {
    icon: <Languages size={18} aria-hidden />,
    title: 'Translation',
    body: 'Any line in English, in place in the Log. No DeepL key of your own needed.',
    docs: '/lookups/translation-and-ai/'
  },
  {
    icon: <Sparkles size={18} aria-hidden />,
    title: 'AI explanations',
    body: 'A grammar-focused breakdown of a line, using the lines before it as context.',
    docs: '/lookups/translation-and-ai/#explain'
  },
  {
    icon: <AudioLines size={18} aria-hidden />,
    title: 'Read aloud',
    body: 'Hear any Japanese line in an ElevenLabs voice.',
    docs: '/lookups/translation-and-ai/#read-aloud'
  },
  {
    icon: <ScanText size={18} aria-hidden />,
    title: 'Cloud OCR',
    body: 'Google Cloud Vision, dependable on almost any text.',
    docs: '/reading/ocr-engines/#cloud-ocr'
  },
  {
    icon: <RefreshCw size={18} aria-hidden />,
    title: 'Sync',
    body: 'Your sessions, Notebook and preferences, in step across your computers.',
    docs: '/cloud/sync/'
  }
]

/**
 * Monthly / Yearly / Lifetime as a segmented control: a well a shade off the card (dark in dark
 * mode; .plan-toggle in index.css) with the chosen plan in an accent pill that slides between the
 * three equal segments.
 */
export function PlanToggle({ value, onChange }: { value: Choice; onChange: (choice: Choice) => void }) {
  const index = CHOICES.indexOf(value)
  return (
    <div
      role="radiogroup"
      aria-label="Billing"
      className="plan-toggle relative grid w-full grid-cols-3 rounded-xl p-1"
    >
      <span
        aria-hidden
        className="absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] rounded-lg bg-accent shadow-[0_4px_12px_-2px_color-mix(in_oklab,var(--k-accent)_70%,transparent),inset_0_1px_0_rgb(255_255_255/0.2)] transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {CHOICES.map((choice) => (
        <button
          key={choice}
          type="button"
          role="radio"
          aria-checked={value === choice}
          onClick={() => onChange(choice)}
          className={`relative rounded-lg px-3 py-2 text-small font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            value === choice ? 'text-white' : 'text-[var(--toggle-ink)] hover:text-[var(--toggle-ink-hover)]'
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

/** What Kimochi Cloud adds, one tile per feature, each linking to its page in the docs. */
function CloudFeatures() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {CLOUD_FEATURES.map((f) => (
        <li key={f.title}>
          <a
            href={docsUrl(f.docs)}
            className="flex h-full gap-3.5 rounded-xl border border-hairline p-4 no-underline transition-colors duration-100 hover:bg-hover sm:flex-col sm:gap-0"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken text-ink-2 ring-1 ring-hairline ring-inset">
              {f.icon}
            </span>
            <span className="flex flex-col sm:mt-3">
              <span className="text-body font-semibold text-ink">{f.title}</span>
              <span className="mt-1 text-small text-ink-2">{f.body}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}

/**
 * Kimochi Cloud: what the paid plan adds, then the free app and the plan side by side, so it is
 * plain the plan is extra.
 */
export function Cloud() {
  const [choice, setChoice] = useState<Choice>('yearly')
  const price = PRICES[choice]
  return (
    <>
      <CloudFeatures />

      <div className="mt-12 grid gap-5 md:mt-16 md:grid-cols-2">
        <div className="flex flex-col rounded-2xl border border-hairline bg-raised p-6 md:p-8">
          <p className="text-meta tracking-[0.08em] text-ink-3 uppercase">Kimochi</p>
          <p className="mt-3 flex items-baseline gap-2">
            <span className="text-[2.5rem] leading-none font-semibold tracking-[-0.02em] text-ink">Free</span>
            <span className="text-small text-ink-3">forever</span>
          </p>
          <p className="mt-3 text-body text-ink-2">Reads your games, manga and more. No account, no limits.</p>
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
          <p className="text-meta tracking-[0.08em] text-accent-ink uppercase">Kimochi Cloud</p>
          <div className="mt-4">
            <PlanToggle value={choice} onChange={setChoice} />
          </div>
          <p className="mt-5 flex items-baseline gap-1.5">
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
      <div className="mt-6 flex flex-col gap-3 text-small text-ink-3 sm:flex-row sm:items-baseline sm:justify-between">
        <p>{PRICE_SUMMARY}</p>
        <a
          href={docsUrl('/cloud/')}
          className="inline-flex shrink-0 items-center gap-1.5 text-ink-2 underline decoration-hairline underline-offset-4 hover:text-ink hover:decoration-current"
        >
          Accounts and plans in the docs
          <ArrowRight size={14} aria-hidden />
        </a>
      </div>
    </>
  )
}
