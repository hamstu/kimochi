import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '../Button'
import { SubmitButton, dangerButtonExtra } from './SubmitButton'

/** One settings group on /account: heading and blurb on the left, content on the right (stacked on phones). */
export function AccountSection({
  id,
  title,
  description,
  children
}: {
  id: string
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className="grid gap-5 border-t border-hairline py-10 md:grid-cols-[15rem_minmax(0,1fr)] md:gap-10">
      <div>
        <h2 id={`${id}-title`} className="text-heading text-ink">
          {title}
        </h2>
        {description && <div className="mt-1.5 text-small text-ink-2">{description}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn'

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-press text-ink-2',
  accent: 'bg-accent-soft text-accent-ink',
  ok: 'bg-[color-mix(in_srgb,var(--k-ok)_14%,transparent)] text-ok',
  warn: 'bg-[color-mix(in_srgb,var(--k-warn-text)_14%,transparent)] text-warn'
}

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-meta ${badgeTones[tone]}`}>{children}</span>
}

/** Load something once on mount, with reload. */
export function useLoad<T>(load: () => Promise<T>) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true })
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }))
    load().then(
      (data) => setState({ data, loading: false }),
      (error: unknown) => setState({ error, loading: false })
    )
  }, [load])
  useEffect(reload, [reload])
  return { ...state, reload, setData: (data: T) => setState({ data, loading: false }) }
}

/** A destructive button that asks once before acting: "Delete…" → "Delete? [Delete] [Cancel]". */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  busyLabel,
  onConfirm,
  disabled
}: {
  label: string
  question: ReactNode
  confirmLabel: string
  busyLabel: string
  onConfirm: () => Promise<void>
  disabled?: boolean
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!asking) {
    return (
      <div>
        <Button variant="secondary" className={dangerButtonExtra} disabled={disabled} onClick={() => setAsking(true)}>
          {label}
        </Button>
      </div>
    )
  }
  return (
    <div role="group" aria-label={label} className="grid gap-3">
      <p className="text-small text-ink">{question}</p>
      <div className="flex flex-wrap gap-2">
        <SubmitButton
          type="button"
          variant="secondary"
          className={dangerButtonExtra}
          busy={busy}
          busyLabel={busyLabel}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await onConfirm()
              setBusy(false)
              setAsking(false)
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
              setBusy(false)
            }
          }}
        >
          {confirmLabel}
        </SubmitButton>
        <Button variant="secondary" disabled={busy} onClick={() => setAsking(false)} autoFocus>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/** Inline "Saved." style status line that announces itself. */
export function StatusLine({ tone = 'ok', children }: { tone?: 'ok' | 'danger'; children: ReactNode }) {
  return (
    <p role={tone === 'danger' ? 'alert' : 'status'} className={`text-small ${tone === 'danger' ? 'text-danger' : 'text-ok'}`}>
      {children}
    </p>
  )
}
