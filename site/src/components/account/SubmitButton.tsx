import type { ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button, type ButtonVariant } from '../Button'

export interface SubmitButtonProps {
  busy: boolean
  /** Label while busy, e.g. "Signing in…". */
  busyLabel: string
  variant?: ButtonVariant
  disabled?: boolean
  className?: string
  type?: 'submit' | 'button'
  onClick?: () => void
  children: ReactNode
}

/** A form's submit button with a disabled, aria-busy state and a spinner while the request runs. */
export function SubmitButton({ busy, busyLabel, variant = 'primary', disabled, className, type = 'submit', onClick, children }: SubmitButtonProps) {
  return (
    <Button
      type={type}
      variant={variant}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
      className={className}
      icon={busy ? <LoaderCircle size={14} aria-hidden className="motion-safe:animate-spin" /> : undefined}
    >
      {busy ? busyLabel : children}
    </Button>
  )
}

/** Classes for a destructive secondary button: danger text on the field ground. */
export const dangerButtonExtra = 'text-danger! hover:bg-[color-mix(in_srgb,var(--k-danger)_10%,transparent)]!'
