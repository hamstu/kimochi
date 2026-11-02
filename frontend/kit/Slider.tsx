import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react'
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

export interface StepOption<T extends string> {
  value: T
  label: string
}

/**
 * A choice on a scale (off → strict): a notched track whose thumb snaps to each step, with the
 * steps' names under their notches; a name is also a button. 3–5 short, ordered options.
 */
export function StepSlider<T extends string>({
  value,
  onValueChange,
  options,
  className,
  'aria-label': ariaLabel
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly StepOption<T>[]
  className?: string
  'aria-label'?: string
}): ReactNode {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )
  const last = options.length - 1
  // Radix keeps the thumb inside the track, so its centre runs from half a thumb in at each end:
  // notches sit under it (the thumb is 0.875rem, .k-slider-thumb).
  const at = (step: number): string => `calc(0.4375rem + (100% - 0.875rem) * ${step / last})`
  return (
    <div className={cn('k-step-slider', className)}>
      <SliderPrimitive.Root
        className="k-slider k-step-slider-track"
        min={0}
        max={last}
        step={1}
        value={[index]}
        onValueChange={([next]) => {
          const option = options[next]
          if (option && option.value !== value) onValueChange(option.value)
        }}
        aria-label={ariaLabel}
      >
        <SliderPrimitive.Track className="k-slider-track">
          <SliderPrimitive.Range className="k-slider-range" />
        </SliderPrimitive.Track>
        {options.map((option, step) => (
          <span
            key={option.value}
            className="k-step-slider-notch"
            data-passed={step <= index || undefined}
            style={{ left: at(step) }}
            aria-hidden
          />
        ))}
        <SliderPrimitive.Thumb className="k-slider-thumb" aria-valuetext={options[index]?.label} />
      </SliderPrimitive.Root>
      <div className="k-step-slider-labels">
        {options.map((option, step) => (
          <button
            key={option.value}
            type="button"
            tabIndex={-1}
            className="k-step-slider-label"
            data-selected={step === index || undefined}
            onClick={() => onValueChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
