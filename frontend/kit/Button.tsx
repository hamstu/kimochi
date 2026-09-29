import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

export type ButtonVariant = 'secondary' | 'primary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  /** Square icon-only button. Give it an `aria-label`. */
  icon?: boolean
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon = false, asChild, className, type, ...props },
  ref
) {
  const Component = asChild ? Slot : 'button'
  return (
    <Component
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(
        'k-button',
        `k-button-${variant}`,
        size === 'sm' && 'k-button-sm',
        icon && 'k-button-icon',
        className
      )}
      {...props}
    />
  )
})

/**
 * Icon-only ghost button. `label` is the accessible name and, unless `tooltip={false}`, a kit
 * tooltip. An outer `Tooltip` wrapping it takes precedence (the inner one steps aside).
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, 'icon'> & {
    label: string
    tooltip?: boolean
    tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  }
>(function IconButton({ label, variant = 'ghost', tooltip = true, tooltipSide, title, ...props }, ref) {
  const button = <Button ref={ref} icon variant={variant} aria-label={label} title={title} {...props} />
  return tooltip && !title ? (
    <Tooltip content={label} side={tooltipSide}>
      {button}
    </Tooltip>
  ) : (
    button
  )
})
