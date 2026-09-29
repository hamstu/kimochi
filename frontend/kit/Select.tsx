import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn, portalRoot } from './cn'

export const SelectRoot = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value
export const SelectGroup = SelectPrimitive.Group

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
    size?: 'sm' | 'md'
    variant?: 'field' | 'ghost'
  }
>(function SelectTrigger({ className, children, size = 'md', variant = 'field', ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        'k-select-trigger',
        size === 'sm' && 'k-select-trigger-sm',
        variant === 'ghost' && 'k-select-trigger-ghost',
        className
      )}
      {...props}
    >
      {children ?? <SelectPrimitive.Value />}
      <SelectPrimitive.Icon asChild>
        <ChevronsUpDown className="k-select-trigger-icon" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
})

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = 'popper', sideOffset = 4, ...props }, ref) {
  return (
    <SelectPrimitive.Portal container={portalRoot()}>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn('k-menu', 'k-select-content', className)}
        {...props}
      >
        <SelectPrimitive.Viewport className="k-select-viewport">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & { icon?: ReactNode; detail?: ReactNode }
>(function SelectItem({ className, children, icon, detail, ...props }, ref) {
  return (
    <SelectPrimitive.Item ref={ref} className={cn('k-menu-item', className)} {...props}>
      {icon}
      <span className="k-menu-item-label">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </span>
      {detail && <span className="k-menu-item-shortcut">{detail}</span>}
      <SelectPrimitive.ItemIndicator className="k-menu-item-check">
        <Check />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
})

export const SelectSeparator = (): ReactNode => <SelectPrimitive.Separator className="k-menu-separator" />
export const SelectLabel = ({ children }: { children: ReactNode }): ReactNode => (
  <SelectPrimitive.Label className="k-menu-label">{children}</SelectPrimitive.Label>
)

/** Convenience select for a flat list of options. */
export interface SelectOption<T extends string> {
  value: T
  label: ReactNode
  detail?: ReactNode
  disabled?: boolean
}

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  size,
  variant,
  className,
  disabled,
  'aria-label': ariaLabel
}: {
  value: T | undefined
  onValueChange: (value: T) => void
  options: readonly SelectOption<T>[]
  placeholder?: string
  size?: 'sm' | 'md'
  variant?: 'field' | 'ghost'
  className?: string
  disabled?: boolean
  'aria-label'?: string
}): ReactNode {
  return (
    <SelectRoot value={value} onValueChange={(v) => onValueChange(v as T)} disabled={disabled}>
      <SelectTrigger size={size} variant={variant} className={className} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled} detail={option.detail}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  )
}
