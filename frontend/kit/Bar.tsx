import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

/** A 28px strip: title bars, tool bars and footers share one height and one plane. */
export function Bar({
  position = 'top',
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { position?: 'top' | 'bottom' }): ReactNode {
  return <div className={cn('k-bar', position === 'top' ? 'k-bar-top' : 'k-bar-bottom', className)} {...props} />
}

export const BarSpacer = (): ReactNode => <span className="k-bar-spacer" />
