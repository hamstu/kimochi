import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'
import { cn } from './cn'

export const Slider = forwardRef<
  ElementRef<typeof SliderPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(function Slider({ className, ...props }, ref) {
  const thumbs = (props.value ?? props.defaultValue ?? [0]).length
  return (
    <SliderPrimitive.Root ref={ref} className={cn('k-slider', className)} {...props}>
      <SliderPrimitive.Track className="k-slider-track">
        <SliderPrimitive.Range className="k-slider-range" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbs }, (_, index) => (
        <SliderPrimitive.Thumb key={index} className="k-slider-thumb" />
      ))}
    </SliderPrimitive.Root>
  )
})
