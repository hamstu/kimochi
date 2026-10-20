import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { Field } from '../components/account/Field'
import { Meter } from '../components/account/Meter'
import { Notice } from '../components/account/Notice'
import { SubmitButton } from '../components/account/SubmitButton'
import { AccountSection, Badge, StatusLine, useLoad } from '../components/account/parts'
import { api, ApiError, type AdminLimits, type AdminUser, type MetricName, type Plan, type Usage } from '../lib/api'
import { formatDay, formatStorage, messageForCode, planLabel } from '../lib/account.js'
import { useSession } from '../lib/session'

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : messageForCode('internal'))

const METRIC_LABELS: Record<MetricName, string> = {
  ocr: 'Cloud OCR (scans / month)',
  translate: 'Translation (requests / month)',
  tts: 'Read aloud (lines / month)',
  explain: 'Explanations (answers / month)',
  storage: 'Sync storage (MB)'
}

const MB = 1_000_000

/** The owner's view: who is on which plan, each plan's allowances, and one person's account. */
export function AccountAdmin() {
  const { status, user } = useSession()
  if (status === 'loading') {
    return (
      <section className="container-page py-14" aria-busy="true">
        <p className="text-ink-3" role="status">
          Loading…
        </p>
      </section>
    )
  }
  if (status === 'signed-out') return <Navigate to="/account/sign-in?returnTo=%2Faccount%2Fadmin" replace />
  if (user?.plan !== 'owner') return <Navigate to="/account" replace />
  return (
    <div className="container-page py-14 md:py-20">
      <div className="mx-auto max-w-[56rem]">
        <Link to="/account" className="inline-flex items-center gap-1.5 text-small text-ink-3 hover:text-ink">
          <ArrowLeft size={14} aria-hidden /> Your account
        </Link>
        <h1 className="mt-3 pb-10 text-title text-ink">Admin</h1>
        <OverviewSection />
        <LimitsSection />
        <PersonSection />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-hairline bg-raised px-4 py-3">
      <p className="text-meta text-ink-3">{label}</p>
      <p className="mt-1 text-heading text-ink tnum">{value.toLocaleString('en-US')}</p>
    </div>
  )
}

function OverviewSection() {
  const overview = useLoad(api.adminOverview)
  const o = overview.data
  const subs = (status: string, interval?: string) =>
    (o?.subscriptions ?? []).filter((s) => s.status === status && (!interval || s.interval === interval)).reduce((n, s) => n + s.count, 0)
  return (
    <AccountSection id="overview" title="Overview" description="Accounts by plan, and the latest subscription changes.">
      {overview.error ? (
        <Notice tone="danger">{errorText(overview.error)}</Notice>
      ) : !o ? (
        <p className="text-small text-ink-3">Loading…</p>
      ) : (
        <div className="grid gap-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Free" value={o.plans.free ?? 0} />
            <Stat label="On trial" value={subs('trialing')} />
            <Stat label="Monthly" value={subs('active', 'month') + subs('past_due', 'month')} />
            <Stat label="Yearly" value={subs('active', 'year') + subs('past_due', 'year')} />
            <Stat label="Lifetime" value={o.lifetime} />
            <Stat label="Payment due" value={subs('past_due')} />
            <Stat label="Kimochi Cloud" value={(o.plans.cloud ?? 0) + (o.plans.trial ?? 0)} />
            <Stat label="Accounts" value={Object.values(o.plans).reduce((n, c) => n + (c ?? 0), 0)} />
          </div>
          {o.recent.length > 0 && (
            <ul className="divide-y divide-hairline rounded-lg border border-hairline">
              {o.recent.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-small">
                  <span className="min-w-0 text-ink break-all">{r.email ?? 'No email'}</span>
                  <span className="flex items-center gap-2 text-ink-3">
                    <Badge tone={r.status === 'active' ? 'ok' : r.status === 'trialing' ? 'accent' : r.status === 'past_due' ? 'warn' : 'neutral'}>
                      {r.status}
                    </Badge>
                    {r.interval ?? ''} · {formatDay(r.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </AccountSection>
  )
}

/** Shown in the inputs: storage in MB, everything else as is; blank = unlimited. */
const toInput = (metric: MetricName, v: number | null) => (v === null ? '' : String(metric === 'storage' ? v / MB : v))
const fromInput = (metric: MetricName, s: string): number | null | undefined => {
  if (s.trim() === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(metric === 'storage' ? n * MB : n)
}

function LimitsSection() {
  const limits = useLoad(api.adminLimits)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const data = limits.data
  const editable: Plan[] = ['free', 'trial', 'cloud', 'owner']

  useEffect(() => {
    if (!data) return
    const next: Record<string, string> = {}
    for (const plan of data.plans) for (const m of data.metrics) next[`${plan}.${m}`] = toInput(m, data.limits[plan][m])
    setDraft(next)
  }, [data])

  async function onSave(e: FormEvent) {
    e.preventDefault()
    if (!data) return
    const changes: Partial<Record<Plan, Partial<Record<MetricName, number | null>>>> = {}
    for (const plan of data.plans) {
      for (const m of data.metrics) {
        const v = fromInput(m, draft[`${plan}.${m}`] ?? '')
        if (v === undefined) {
          setMessage({ tone: 'danger', text: `${planLabel(plan)} · ${METRIC_LABELS[m]}: enter a number of 0 or more, or leave it blank for unlimited.` })
          return
        }
        if (v !== data.limits[plan][m]) (changes[plan] ??= {})[m] = v
      }
    }
    setBusy(true)
    setMessage(null)
    try {
      const saved = await api.adminSetLimits(changes)
      limits.setData({ ...data, limits: saved } as AdminLimits)
      setMessage({ tone: 'ok', text: 'Saved. Every server picks it up within 30 seconds.' })
    } catch (err) {
      setMessage({ tone: 'danger', text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AccountSection
      id="limits"
      title="Allowances"
      description="What each plan can use. Monthly counts reset on the 1st (UTC). Leave a box blank for unlimited; 0 turns the service off for that plan."
    >
      {limits.error ? (
        <Notice tone="danger">{errorText(limits.error)}</Notice>
      ) : !data ? (
        <p className="text-small text-ink-3">Loading…</p>
      ) : (
        <form onSubmit={onSave} className="grid gap-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-small">
              <thead>
                <tr className="text-left text-ink-3">
                  <th className="py-2 pr-3 font-medium">Allowance</th>
                  {editable.map((p) => (
                    <th key={p} className="px-1.5 py-2 font-medium">
                      {planLabel(p).replace('Kimochi Cloud trial', 'Trial').replace('Kimochi Cloud', 'Cloud')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((m) => (
                  <tr key={m} className="border-t border-hairline">
                    <td className="py-2 pr-3 text-ink">{METRIC_LABELS[m]}</td>
                    {editable.map((p) => (
                      <td key={p} className="px-1.5 py-1.5">
                        <input
                          aria-label={`${planLabel(p)}: ${METRIC_LABELS[m]}`}
                          inputMode="numeric"
                          placeholder="∞"
                          value={draft[`${p}.${m}`] ?? ''}
                          onChange={(e) => {
                            setDraft((d) => ({ ...d, [`${p}.${m}`]: e.target.value }))
                            setMessage(null)
                          }}
                          className="h-8 w-full min-w-[5rem] rounded-md bg-field px-2 text-ink tnum shadow-[inset_0_0_0_1px_var(--k-line-strong)] outline-none focus:shadow-[inset_0_0_0_2px_var(--k-accent)]"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton busy={busy} busyLabel="Saving…">
              Save allowances
            </SubmitButton>
            {message && <StatusLine tone={message.tone}>{message.text}</StatusLine>}
          </div>
        </form>
      )}
    </AccountSection>
  )
}

function PersonSection() {
  const [email, setEmail] = useState('')
  const [found, setFound] = useState<{ user: AdminUser; usage: Usage } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  async function lookUp(e?: FormEvent) {
    e?.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      setFound(await api.adminUser(email.trim()))
    } catch (err) {
      setFound(null)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function change(b: { grant?: 'cloud' | 'owner' | null; status?: 'active' | 'suspended' }) {
    if (!found?.user.email) return
    setBusy(true)
    setError(null)
    try {
      await api.adminSetUser({ email: found.user.email, ...b })
      setFound(await api.adminUser(found.user.email))
      setSaved('Saved.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const u = found?.user
  return (
    <AccountSection
      id="person"
      title="Someone’s account"
      description="Look someone up by email to see their plan and usage, give them Kimochi Cloud for free, or suspend them."
    >
      <form onSubmit={lookUp} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <Field label="Email" type="email" name="lookup" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        </div>
        <SubmitButton variant="secondary" busy={busy && !found} busyLabel="Looking…">
          Look up
        </SubmitButton>
      </form>
      {error && (
        <Notice tone="danger" className="mt-4">
          {error}
        </Notice>
      )}
      {u && found && (
        <div className="mt-6 grid gap-5 rounded-lg border border-hairline p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink break-all">{u.displayName ? `${u.displayName} · ` : ''}{u.email}</span>
            <Badge tone={u.cloud ? 'accent' : 'neutral'}>{planLabel(u.plan)}</Badge>
            {u.status === 'suspended' && <Badge tone="warn">Suspended</Badge>}
          </div>
          <p className="text-small text-ink-2">
            {u.billing.source === 'subscription'
              ? `Stripe subscription: ${u.billing.status}, ${u.billing.interval ?? ''}${u.billing.cancelAt ? `, ends ${formatDay(u.billing.cancelAt)}` : u.billing.periodEnd ? `, renews ${formatDay(u.billing.periodEnd)}` : ''}.`
              : u.billing.source === 'lifetime'
                ? 'Bought lifetime.'
                : u.billing.source === 'grant'
                  ? `Granted ${u.grant === 'owner' ? 'owner' : 'Kimochi Cloud'} by you.`
                  : u.billing.status
                    ? `No live plan (last subscription: ${u.billing.status}).`
                    : 'Never subscribed.'}{' '}
            Joined {formatDay(u.createdAt)}.
          </p>
          <div className="grid gap-4">
            {(['ocr', 'translate', 'tts', 'explain'] as const).map((m) => (
              <Meter key={m} label={METRIC_LABELS[m].replace(/ \(.*\)/, '')} used={found.usage.metrics[m].used} limit={found.usage.metrics[m].limit} />
            ))}
            <Meter
              label="Sync storage"
              used={found.usage.metrics.storage.used}
              limit={found.usage.metrics.storage.limit}
              format={(n) => formatStorage(n)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {u.grant === 'cloud' ? (
              <SubmitButton type="button" variant="secondary" busy={busy} busyLabel="Saving…" onClick={() => change({ grant: null })}>
                Remove free Kimochi Cloud
              </SubmitButton>
            ) : u.grant !== 'owner' ? (
              <SubmitButton type="button" variant="secondary" busy={busy} busyLabel="Saving…" onClick={() => change({ grant: 'cloud' })}>
                Give Kimochi Cloud for free
              </SubmitButton>
            ) : null}
            <SubmitButton
              type="button"
              variant="secondary"
              busy={busy}
              busyLabel="Saving…"
              onClick={() => change({ status: u.status === 'suspended' ? 'active' : 'suspended' })}
            >
              {u.status === 'suspended' ? 'Lift suspension' : 'Suspend'}
            </SubmitButton>
            {saved && <StatusLine>{saved}</StatusLine>}
          </div>
        </div>
      )}
    </AccountSection>
  )
}
