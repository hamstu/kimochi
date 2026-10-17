import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: ReactNode
  /** Quiet help under the input. */
  hint?: ReactNode
  /** Inline error; marks the input invalid and is announced with it. */
  error?: string | null
  className?: string
  inputClassName?: string
}

export const inputClass =
  'block h-10 w-full min-w-0 rounded-md bg-field px-3 text-body text-ink placeholder:text-ink-3 ' +
  'shadow-[inset_0_0_0_1px_var(--k-line-strong)] transition-shadow duration-100 ' +
  'disabled:opacity-60 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--k-danger)]'

/** Labelled text input with hint and inline error, wired with aria-describedby. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, className = '', inputClassName = '', id, ...input },
  ref
) {
  const auto = useId()
  const inputId = id ?? auto
  const hintId = hint ? `${inputId}-hint` : undefined
  const errorId = error ? `${inputId}-error` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined
  return (
    <div className={className}>
      <label htmlFor={inputId} className="block text-small font-medium text-ink">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`mt-1.5 ${inputClass} ${inputClassName}`}
        {...input}
      />
      {error && (
        <p id={errorId} className="mt-1.5 text-small text-danger">
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="mt-1.5 text-small text-ink-3">
          {hint}
        </p>
      )}
    </div>
  )
})
