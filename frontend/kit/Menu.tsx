import {
  createContext,
  forwardRef,
  useContext,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { Check, ChevronRight } from 'lucide-react'
import { cn, portalRoot } from './cn'
import { closeAutoFocusFromKeyboardOnly } from './focus'

/**
 * Every part below renders for the menu it sits in: a `Menu` (opened by its trigger) or a
 * `ContextMenu` (opened by a right-click on its trigger). One list of items can then serve a row's
 * ⋯ button and a right-click on the row.
 */
const InContextMenu = createContext(false)
/** The Radix parts for the menu being rendered. Both packages export the same part names. */
const usePrimitive = (): typeof MenuPrimitive =>
  useContext(InContextMenu) ? (ContextMenuPrimitive as unknown as typeof MenuPrimitive) : MenuPrimitive

export function Menu(props: ComponentPropsWithoutRef<typeof MenuPrimitive.Root>): ReactNode {
  return (
    <InContextMenu.Provider value={false}>
      <MenuPrimitive.Root {...props} />
    </InContextMenu.Provider>
  )
}
export const MenuTrigger = MenuPrimitive.Trigger

/** A menu opened by right-clicking its trigger, at the pointer, instead of the system's. */
export function ContextMenu(props: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Root>): ReactNode {
  return (
    <InContextMenu.Provider value={true}>
      <ContextMenuPrimitive.Root {...props} />
    </InContextMenu.Provider>
  )
}
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger

export function MenuGroup(props: ComponentPropsWithoutRef<typeof MenuPrimitive.Group>): ReactNode {
  const P = usePrimitive()
  return <P.Group {...props} />
}
export function MenuRadioGroup(props: ComponentPropsWithoutRef<typeof MenuPrimitive.RadioGroup>): ReactNode {
  const P = usePrimitive()
  return <P.RadioGroup {...props} />
}
export function MenuSub(props: ComponentPropsWithoutRef<typeof MenuPrimitive.Sub>): ReactNode {
  const P = usePrimitive()
  return <P.Sub {...props} />
}

export const MenuContent = forwardRef<
  ElementRef<typeof MenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(function MenuContent(
  { className, sideOffset = 4, collisionPadding = 8, onCloseAutoFocus, onKeyDown, ...props },
  ref
) {
  const P = usePrimitive()
  // A letter that is an item's `shortcut` chooses that item (before Radix's type-to-find).
  const chooseByShortcut = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return
    const item = event.currentTarget.querySelector<HTMLElement>(
      `[data-shortcut="${CSS.escape(event.key.toLowerCase())}"]:not([data-disabled])`
    )
    if (!item) return
    event.preventDefault()
    item.click()
  }
  return (
    <P.Portal container={portalRoot()}>
      <P.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        onCloseAutoFocus={onCloseAutoFocus ?? closeAutoFocusFromKeyboardOnly}
        className={cn('k-menu', className)}
        onKeyDown={chooseByShortcut}
        {...props}
      />
    </P.Portal>
  )
})

export const MenuItem = forwardRef<
  ElementRef<typeof MenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
    icon?: ReactNode
    /** A letter key, shown as a key cap: pressing it while the menu is open chooses the item. (The
        row the menu is for usually takes the same key while pointed at.) */
    shortcut?: string
    tone?: 'default' | 'danger'
  }
>(function MenuItem({ className, icon, shortcut, tone = 'default', children, ...props }, ref) {
  const P = usePrimitive()
  return (
    <P.Item
      ref={ref}
      className={cn('k-menu-item', tone === 'danger' && 'k-menu-item-danger', className)}
      data-shortcut={shortcut?.toLowerCase()}
      {...props}
    >
      {icon}
      <span className="k-menu-item-label">{children}</span>
      {shortcut && (
        <kbd className="k-kbd k-menu-item-key" aria-hidden>
          {shortcut.toUpperCase()}
        </kbd>
      )}
    </P.Item>
  )
})

export const MenuRadioItem = forwardRef<
  ElementRef<typeof MenuPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem> & { icon?: ReactNode; detail?: ReactNode }
>(function MenuRadioItem({ className, icon, detail, children, ...props }, ref) {
  const P = usePrimitive()
  return (
    <P.RadioItem ref={ref} className={cn('k-menu-item', className)} {...props}>
      {icon}
      <span className="k-menu-item-label">{children}</span>
      {detail && <span className="k-menu-item-shortcut">{detail}</span>}
      <P.ItemIndicator className="k-menu-item-check">
        <Check />
      </P.ItemIndicator>
    </P.RadioItem>
  )
})

export const MenuCheckboxItem = forwardRef<
  ElementRef<typeof MenuPrimitive.CheckboxItem>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.CheckboxItem> & { icon?: ReactNode }
>(function MenuCheckboxItem({ className, icon, children, ...props }, ref) {
  const P = usePrimitive()
  return (
    <P.CheckboxItem ref={ref} className={cn('k-menu-item', className)} {...props}>
      {icon}
      <span className="k-menu-item-label">{children}</span>
      <P.ItemIndicator className="k-menu-item-check">
        <Check />
      </P.ItemIndicator>
    </P.CheckboxItem>
  )
})

export function MenuSeparator(): ReactNode {
  const P = usePrimitive()
  return <P.Separator className="k-menu-separator" />
}
export function MenuLabel({ children }: { children: ReactNode }): ReactNode {
  const P = usePrimitive()
  return <P.Label className="k-menu-label">{children}</P.Label>
}

/**
 * A row that opens a submenu. `checked` shows the same check as a radio item, for an option that
 * is both a choice and a group of further actions (the source menu's Screen).
 */
export const MenuSubTrigger = forwardRef<
  ElementRef<typeof MenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.SubTrigger> & { icon?: ReactNode; checked?: boolean }
>(function MenuSubTrigger({ className, icon, checked, children, ...props }, ref) {
  const P = usePrimitive()
  return (
    <P.SubTrigger
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
    </P.SubTrigger>
  )
})

export const MenuSubContent = forwardRef<
  ElementRef<typeof MenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.SubContent>
>(function MenuSubContent({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) {
  const P = usePrimitive()
  return (
    <P.Portal container={portalRoot()}>
      <P.SubContent
        ref={ref}
        sideOffset={sideOffset}
        alignOffset={-4}
        collisionPadding={collisionPadding}
        className={cn('k-menu', className)}
        {...props}
      />
    </P.Portal>
  )
})
