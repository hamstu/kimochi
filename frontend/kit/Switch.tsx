import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from './cn'

export const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { size?: 'sm' | 'md' }
>(function Switch({ className, size = 'md', ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn('k-switch', size === 'sm' && 'k-switch-sm', className)}
      {...props}
    >
      <SwitchPrimitive.Thumb className="k-switch-thumb" />
    </SwitchPrimitive.Root>
  )
})
