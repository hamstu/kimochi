import { useState } from 'react'
import { CreditCard } from 'lucide-react'
import { Button } from '../Button'
import { Meter } from './Meter'
import { Notice } from './Notice'
import { AccountSection, Badge, StatusLine, useLoad } from './parts'
import { PlanToggle, fineprint } from '../home/OpenSource'
import { api, ApiError, type Choice, type MetricName, type User } from '../../lib/api'
import { formatDay, formatResetDay, messageForCode, resetDay } from '../../lib/account.js'
import { PRICES, ctaLabel, goToCheckout, goToPortal } from '../../lib/billing'

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : messageForCode('internal'))

const MONTHLY: { key: Exclude<MetricName, 'storage'>; label: string; unit: string }[] = [
  { key: 'ocr', label: 'Cloud OCR', unit: 'scans' },
  { key: 'translate', label: 'Translation', unit: 'requests' },
  { key: 'tts', label: 'Read aloud', unit: 'lines' },
  { key: 'explain', label: 'Explanations', unit: 'answers' }
]

/** A button that leaves for Stripe (Checkout or the portal), with its own busy and error state. */
function StripeButton({
  go,
  children,
  variant = 'primary',
  busyLabel
}: {
  go: () => Promise<void>
  children: string
  variant?: 'primary' | 'secondary'
  busyLabel: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="grid justify-items-start gap-2">
      <Button
        variant={variant}
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await go()
          } catch (err) {
            setBusy(false)
            setError(errorText(err))
          }
        }}
      >
        {busy ? busyLabel : children}
      </Button>
      {error && <StatusLine tone="danger">{error}</StatusLine>}
    </div>
  )
}

/** One sentence on where the plan stands: when the trial ends, when it renews or stops. */
function planStatus(user: User): { title: string; line: string | null; tone?: 'warn' } {
  const b = user.billing
  if (user.plan === 'owner') return { title: 'Owner', line: 'Everything, without limits.' }
  if (b.source === 'grant') return { title: 'Kimochi Cloud', line: 'On the house. Thank you for being part of Kimochi.' }
  if (b.source === 'lifetime') return { title: 'Kimochi Cloud · Lifetime', line: 'Paid once, yours for good. Thank you!' }
  if (b.source === 'subscription') {
    const per = b.interval === 'year' ? '$60 a year' : '$6 a month'
    const interval = b.interval === 'year' ? 'Yearly' : 'Monthly'
    if (b.status === 'trialing') {
      return b.cancelAt
        ? { title: 'Kimochi Cloud trial', line: `Your trial ends on ${formatDay(b.trialEnd)}. You won’t be charged.` }
        : { title: 'Kimochi Cloud trial', line: `Free until ${formatDay(b.trialEnd)}, then ${per}.` }
    }
    if (b.status === 'past_due') {
      return { title: `Kimochi Cloud · ${interval}`, line: 'Your last payment didn’t go through. Update your card to keep Kimochi Cloud.', tone: 'warn' }
    }
    return b.cancelAt
      ? { title: `Kimochi Cloud · ${interval}`, line: `Cancelled. Kimochi Cloud stays on until ${formatDay(b.cancelAt)}.` }
      : { title: `Kimochi Cloud · ${interval}`, line: `${per}, renews on ${formatDay(b.periodEnd)}.` }
  }
  return { title: 'Free', line: null }
}

/** The free account's way in: the same choice as the home page's Cloud card. */
function ChoosePlan({ user }: { user: User }) {
  const [choice, setChoice] = useState<Choice>('yearly')
  const price = PRICES[choice]
  const trial = user.billing.trialAvailable
  return (
    <div className="rounded-xl border border-[color-mix(in_oklab,var(--k-accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--k-accent)_6%,var(--k-raised))] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-meta tracking-[0.08em] text-accent-ink uppercase">Kimochi Cloud</p>
        <PlanToggle value={choice} onChange={setChoice} />
      </div>
      <p className="mt-3 flex items-baseline gap-1.5">
        <span className="text-[1.75rem] leading-none font-semibold text-ink tnum">{price.amount}</span>
        <span className="text-small text-ink-3">{price.per}</span>
        <span className="ml-1 text-small text-ink-3">· {price.note}</span>
      </p>
      <p className="mt-3 text-small text-ink-2">
        Cloud OCR, read aloud, translation, AI explanations and Sync across your computers, right in the app.
      </p>
      <div className="mt-4 grid gap-2">
        <StripeButton go={() => goToCheckout(choice, 'account')} busyLabel="Opening checkout…">
          {ctaLabel(choice, trial)}
        </StripeButton>
        <span className="text-small text-ink-3">{fineprint(choice, trial)}</span>
      </div>
    </div>
  )
}

export function PlanSection({ user }: { user: User }) {
  const usage = useLoad(api.usage)
  const reset = usage.data ? resetDay(usage.data.period.end) : null
  const status = planStatus(user)
  const b = user.billing
  return (
    <AccountSection
      id="plan"
      title="Plan"
      description="Kimochi itself is free. Kimochi Cloud adds the online services, each with a generous monthly allowance."
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-heading text-ink">{status.title}</span>
        {b.status === 'trialing' && <Badge tone="accent">Trial</Badge>}
        {b.status === 'past_due' && <Badge tone="warn">Payment due</Badge>}
        {user.status === 'suspended' && <Badge tone="warn">Suspended</Badge>}
      </div>
      {status.line &&
        (status.tone === 'warn' ? (
          <Notice tone="warn" className="mt-3">
            {status.line}
          </Notice>
        ) : (
          <p className="mt-1.5 text-ink-2">{status.line}</p>
        ))}
      {user.status === 'suspended' && (
        <Notice tone="warn" className="mt-4">
          This account is suspended, so the online services are paused. You can still see your account, and Sync keeps working.
        </Notice>
      )}

      {!user.cloud && (
        <div className="mt-5">
          <ChoosePlan user={user} />
        </div>
      )}

      {(b.hasCustomer || (b.source === 'subscription' && user.cloud)) && (
        <div className="mt-5 flex flex-wrap items-start gap-3">
          {b.hasCustomer && (
            <StripeButton variant={user.cloud ? 'primary' : 'secondary'} go={goToPortal} busyLabel="Opening billing…">
              Manage billing
            </StripeButton>
          )}
          {b.source === 'subscription' && user.cloud && (
            <StripeButton variant="secondary" go={() => goToCheckout('lifetime', 'account')} busyLabel="Opening checkout…">
              Switch to lifetime ($125 once)
            </StripeButton>
          )}
        </div>
      )}
      {b.hasCustomer && (
        <p className="mt-3 flex items-center gap-1.5 text-small text-ink-3">
          <CreditCard size={14} aria-hidden />
          Card, invoices, switching monthly and yearly, and cancelling are handled by Stripe.
        </p>
      )}

      {user.cloud && (
        <div className="mt-8">
          <h3 className="text-small font-medium text-ink-2">This month</h3>
          <div className="mt-3">
            {usage.loading && !usage.data ? (
              <p className="text-small text-ink-3" role="status">
                Loading usage…
              </p>
            ) : usage.error ? (
              <Notice tone="danger">
                {errorText(usage.error)}{' '}
                <button type="button" className="text-accent-ink underline" onClick={usage.reload}>
                  Try again
                </button>
              </Notice>
            ) : usage.data ? (
              <div className="grid gap-5">
                {MONTHLY.map((m) => {
                  const metric = usage.data!.metrics[m.key]
                  return metric ? <Meter key={m.key} label={m.label} unit={m.unit} used={metric.used} limit={metric.limit} /> : null
                })}
                {reset && (
                  <p className="text-small text-ink-3">
                    Counts reset on <time dateTime={reset.toISOString()}>{formatResetDay(reset)}</time> (00:00 UTC).
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </AccountSection>
  )
}
