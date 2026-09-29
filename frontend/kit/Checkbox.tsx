import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import { cn } from './cn'

export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root ref={ref} className={cn('k-checkbox', className)} {...props}>
      <CheckboxPrimitive.Indicator>
        {props.checked === 'indeterminate' ? <Minus /> : <Check />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
})
