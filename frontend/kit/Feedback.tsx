import type { HTMLAttributes, ReactNode } from 'react'
import { Info, TriangleAlert, CircleAlert } from 'lucide-react'
import { cn } from './cn'

export type Tone = 'neutral' | 'accent' | 'warn' | 'danger' | 'ok'

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }): ReactNode {
  return <span className={cn('k-badge', tone !== 'neutral' && `k-badge-${tone}`, className)} {...props} />
}

export function StatusDot({ tone = 'neutral', className }: { tone?: Tone; className?: string }): ReactNode {
  return <span aria-hidden className={cn('k-dot', tone !== 'neutral' && `k-dot-${tone}`, className)} />
}

const CALLOUT_ICONS: Record<Tone, ReactNode> = {
  neutral: <Info />,
  accent: <Info />,
  ok: <Info />,
  warn: <TriangleAlert />,
  danger: <CircleAlert />
}

export function Callout({
  tone = 'neutral',
  icon,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: Tone; icon?: ReactNode }): ReactNode {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('k-callout', tone !== 'neutral' && `k-callout-${tone}`, className)}
      {...props}
    >
      {icon ?? CALLOUT_ICONS[tone]}
      <div className="k-callout-body">{children}</div>
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
  className
}: {
  icon?: ReactNode
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}): ReactNode {
  return (
    <div className={cn('k-empty', className)}>
      {icon}
      <p className="k-empty-title">{title}</p>
      {children && <p className="k-empty-body">{children}</p>}
      {actions && <div className="k-empty-actions">{actions}</div>}
    </div>
  )
}

export const Spinner = ({ label = 'Loading' }: { label?: string }): ReactNode => (
  <span className="k-spinner" role="status" aria-label={label} />
)

export const Kbd = ({ children }: { children: ReactNode }): ReactNode => <kbd className="k-kbd">{children}</kbd>
