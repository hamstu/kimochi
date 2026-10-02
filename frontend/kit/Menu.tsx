import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react'
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight } from 'lucide-react'
import { cn, portalRoot } from './cn'
import { closeAutoFocusFromKeyboardOnly } from './focus'

export const Menu = MenuPrimitive.Root
export const MenuTrigger = MenuPrimitive.Trigger
export const MenuGroup = MenuPrimitive.Group
export const MenuRadioGroup = MenuPrimitive.RadioGroup
export const MenuSub = MenuPrimitive.Sub

export const MenuContent = forwardRef<
  ElementRef<typeof MenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(function MenuContent(
  { className, sideOffset = 4, collisionPadding = 8, onCloseAutoFocus, ...props },
  ref
) {
  return (
    <MenuPrimitive.Portal container={portalRoot()}>
      <MenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        onCloseAutoFocus={onCloseAutoFocus ?? closeAutoFocusFromKeyboardOnly}
        className={cn('k-menu', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
})

export const MenuItem = forwardRef<
  ElementRef<typeof MenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
    icon?: ReactNode
    shortcut?: ReactNode
    tone?: 'default' | 'danger'
  }
>(function MenuItem({ className, icon, shortcut, tone = 'default', children, ...props }, ref) {
  return (
    <MenuPrimitive.Item
      ref={ref}
      className={cn('k-menu-item', tone === 'danger' && 'k-menu-item-danger', className)}
      {...props}
    >
      {icon}
      <span className="k-menu-item-label">{children}</span>
      {shortcut && <span className="k-menu-item-shortcut">{shortcut}</span>}
    </MenuPrimitive.Item>
  )
})

export const MenuRadioItem = forwardRef<
  ElementRef<typeof MenuPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem> & { icon?: ReactNode; detail?: ReactNode }
>(function MenuRadioItem({ className, icon, detail, children, ...props }, ref) {
  return (
    <MenuPrimitive.RadioItem ref={ref} className={cn('k-menu-item', className)} {...props}>
      {icon}
      <span className="k-menu-item-label">{children}</span>
      {detail && <span className="k-menu-item-shortcut">{detail}</span>}
      <MenuPrimitive.ItemIndicator className="k-menu-item-check">
        <Check />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  )
})

export const MenuCheckboxItem = forwardRef<
  ElementRef<typeof MenuPrimitive.CheckboxItem>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.CheckboxItem> & { icon?: ReactNode }
>(function MenuCheckboxItem({ className, icon, children, ...props }, ref) {
  return (
    <MenuPrimitive.CheckboxItem ref={ref} className={cn('k-menu-item', className)} {...props}>
      {icon}
      <span className="k-menu-item-label">{children}</span>
      <MenuPrimitive.ItemIndicator className="k-menu-item-check">
        <Check />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.CheckboxItem>
  )
})

export const MenuSeparator = (): ReactNode => <MenuPrimitive.Separator className="k-menu-separator" />
export const MenuLabel = ({ children }: { children: ReactNode }): ReactNode => (
  <MenuPrimitive.Label className="k-menu-label">{children}</MenuPrimitive.Label>
)

/**
 * A row that opens a submenu. `checked` shows the same check as a radio item, for an option that
 * is both a choice and a group of further actions (the source menu's Screen).
 */
export const MenuSubTrigger = forwardRef<
  ElementRef<typeof MenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.SubTrigger> & { icon?: ReactNode; checked?: boolean }
>(function MenuSubTrigger({ className, icon, checked, children, ...props }, ref) {
  return (
    <MenuPrimitive.SubTrigger
      ref={ref}
      className={cn('k-menu-item k-menu-sub-trigger', className)}
      data-checked={checked ? '' : undefined}
      {...props}
    >
      {icon}
      <span className="k-menu-item-label">{children}</span>
      {checked && (
        <span className="k-menu-item-check">
          <Check />
        </span>
      )}
      <ChevronRight className="k-menu-sub-chevron" />
    </MenuPrimitive.SubTrigger>
  )
})

export const MenuSubContent = forwardRef<
  ElementRef<typeof MenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.SubContent>
>(function MenuSubContent({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) {
  return (
    <MenuPrimitive.Portal container={portalRoot()}>
      <MenuPrimitive.SubContent
        ref={ref}
        sideOffset={sideOffset}
        alignOffset={-4}
        collisionPadding={collisionPadding}
        className={cn('k-menu', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
})
