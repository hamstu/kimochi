import type { ReactNode } from 'react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { cn } from './cn'

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

/** Single-choice segmented control for 2–4 short options. */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  className,
  'aria-label': ariaLabel
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly SegmentOption<T>[]
  className?: string
  'aria-label'?: string
}): ReactNode {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => next && onValueChange(next as T)}
      className={cn('k-segmented', className)}
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className="k-segmented-item"
        >
          {option.icon}
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}

export interface ChoiceOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  detail?: ReactNode
  disabled?: boolean
}

/** Mutually exclusive modes that each need a line of explanation (input source, engine). */
export function ChoiceGroup<T extends string>({
  value,
  onValueChange,
  options,
  className,
  'aria-label': ariaLabel
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly ChoiceOption<T>[]
  className?: string
  'aria-label'?: string
}): ReactNode {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => next && onValueChange(next as T)}
      className={cn('k-choice-group', className)}
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <ToggleGroup.Item key={option.value} value={option.value} disabled={option.disabled} className="k-choice">
          <span className="k-choice-head">
            {option.icon}
            {option.label}
          </span>
          {option.detail && <span className="k-choice-detail">{option.detail}</span>}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
