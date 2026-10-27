import { createContext, useContext, type ReactNode } from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn, portalRoot } from './cn'

export const TooltipProvider = TooltipPrimitive.Provider

/** Set inside a tooltip's trigger so a nested Tooltip (e.g. an IconButton's own) steps aside. */
const InsideTooltip = createContext(false)

export function Tooltip({
  content,
  children,
  side = 'top',
  hidden,
  delayDuration,
  className
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  hidden?: boolean
  delayDuration?: number
  className?: string
}): ReactNode {
  const nested = useContext(InsideTooltip)
  if (hidden || !content || nested) return children
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <InsideTooltip.Provider value>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      </InsideTooltip.Provider>
      <TooltipPrimitive.Portal container={portalRoot()}>
        <TooltipPrimitive.Content side={side} sideOffset={6} collisionPadding={8} className={cn('k-tooltip', className)}>
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
