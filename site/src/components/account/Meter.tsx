import { usageFraction } from '../../lib/account.js'

export interface MeterProps {
  label: string
  used: number
  limit: number | null
  /** Formats a count for display ("12", "12.3 MB"). */
  format?: (n: number) => string
  /** Unit noun after the numbers, e.g. "scans". */
  unit?: string
}

/**
 * One allowance as a labelled bar: "120 of 500 scans". Unlimited allowances show the count only.
 * The range is indigo like the app's sliders; it turns warn at 90% and danger when used up.
 */
export function Meter({ label, used, limit, format = (n) => n.toLocaleString('en-US'), unit }: MeterProps) {
  const frac = usageFraction(used, limit)
  const text =
    limit === null
      ? `${format(used)}${unit ? ` ${unit}` : ''} used · unlimited`
      : `${format(used)} of ${format(limit)}${unit ? ` ${unit}` : ''}`
  const fill = frac === null ? '' : frac >= 1 ? 'bg-[var(--k-danger)]' : frac >= 0.9 ? 'bg-warn' : 'bg-accent'
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-small">
        <span className="font-medium text-ink">{label}</span>
        <span className="text-ink-2 tnum">{text}</span>
      </div>
      {frac !== null && (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={limit ?? 0}
          aria-valuenow={Math.min(used, limit ?? used)}
          aria-valuetext={text}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-press"
        >
          <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.max(frac * 100, used > 0 ? 2 : 0)}%` }} />
        </div>
      )}
    </div>
  )
}
