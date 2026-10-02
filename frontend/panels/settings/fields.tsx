/** Small controls shared by several settings pages. */
import type { ReactNode } from 'react'
import { Input } from '@kit'

/** A clamped integer field on the right of a settings row. */
export function NumberField({
  id,
  value,
  min,
  max,
  step,
  fallback,
  disabled,
  onCommit,
  'aria-label': ariaLabel
}: {
  id?: string
  value: number
  min: number
  max: number
  step: number
  fallback: number
  disabled?: boolean
  onCommit: (value: number) => void
  'aria-label'?: string
}): ReactNode {
  return (
    <Input
      id={id}
      type="number"
      className="settings-field-num k-num"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={value}
      onChange={(e) =>
        onCommit(Math.max(min, Math.min(max, parseInt(e.target.value, 10) || fallback)))
      }
    />
  )
}
