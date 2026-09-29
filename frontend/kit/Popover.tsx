import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn, portalRoot } from './cn'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor
export const PopoverClose = PopoverPrimitive.Close

export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & { menu?: boolean }
>(function PopoverContent({ className, sideOffset = 6, collisionPadding = 8, menu, ...props }, ref) {
  return (
    <PopoverPrimitive.Portal container={portalRoot()}>
      <PopoverPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(menu ? 'k-menu' : 'k-popover', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
})
