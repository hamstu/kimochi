import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'

/**
 * The remote's row: full-bleed, 32px, icon + label + optional trailing control. The unit most
 * Kimochi lists are built from (controller, settings rail, tray, pickers).
 */
export interface RowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode
  /** Trailing content: a switch, a count, a chevron. */
  trailing?: ReactNode
  tone?: 'default' | 'danger'
  selected?: boolean
}

export const Row = forwardRef<HTMLButtonElement, RowProps>(function Row(
  { icon, trailing, tone = 'default', selected, className, children, type, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-current={selected ? 'page' : undefined}
      className={cn('k-row', tone === 'danger' && 'k-row-danger', className)}
      {...props}
    >
      {icon}
      <span className="k-row-label">{children}</span>
      {trailing}
    </button>
  )
})

export function RowList({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div className={cn('k-row-list', className)} {...props} />
}

export function Separator({
  inset,
  vertical,
  className
}: {
  inset?: boolean
  vertical?: boolean
  className?: string
}): ReactNode {
  return (
    <div
      role="separator"
      data-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn('k-separator', inset && 'k-separator-inset', className)}
    />
  )
}
