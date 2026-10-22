import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'
import { cn } from './cn'

export const Slider = forwardRef<
  ElementRef<typeof SliderPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
    /** What a thumb's value means, read out in place of the number (a step's name). */
    valueText?: (value: number) => string
  }
>(function Slider({ className, valueText, ...props }, ref) {
  const values = props.value ?? props.defaultValue ?? [0]
  const thumbs = values.length
  return (
    <SliderPrimitive.Root ref={ref} className={cn('k-slider', className)} {...props}>
      <SliderPrimitive.Track className="k-slider-track">
        <SliderPrimitive.Range className="k-slider-range" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbs }, (_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          className="k-slider-thumb"
          aria-valuetext={valueText?.(values[index])}
        />
      ))}
    </SliderPrimitive.Root>
  )
})
