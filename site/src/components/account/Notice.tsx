import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'

export type NoticeTone = 'info' | 'ok' | 'warn' | 'danger'

const tones: Record<NoticeTone, { ground: string; icon: string; Icon: typeof Info }> = {
  info: { ground: 'bg-accent-soft', icon: 'text-accent-ink', Icon: Info },
  ok: { ground: 'bg-[color-mix(in_srgb,var(--k-ok)_12%,transparent)]', icon: 'text-ok', Icon: CircleCheck },
  warn: {
    ground: 'bg-[color-mix(in_srgb,var(--k-warn-text)_12%,transparent)]',
    icon: 'text-warn',
    Icon: TriangleAlert
  },
  danger: {
    ground: 'bg-[color-mix(in_srgb,var(--k-danger)_10%,transparent)]',
    icon: 'text-danger',
    Icon: CircleAlert
  }
}

/**
 * Tinted callout (no border, per DESIGN.md). Errors use role="alert" so they are announced;
 * other tones use role="status".
 */
export function Notice({ tone = 'info', children, className = '' }: { tone?: NoticeTone; children: ReactNode; className?: string }) {
  const t = tones[tone]
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex gap-2.5 rounded-lg px-3.5 py-3 text-small text-ink ${t.ground} ${className}`}
    >
      <t.Icon size={16} aria-hidden className={`mt-[3px] shrink-0 ${t.icon}`} />
      <div className="min-w-0 [&_a]:text-accent-ink">{children}</div>
    </div>
  )
}
