import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as AlertPrimitive from '@radix-ui/react-alert-dialog'
import { X } from 'lucide-react'
import { cn, portalRoot } from './cn'
import { IconButton } from './Button'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

/**
 * Centred modal with header, scrolling body and a bar-plane footer. `variant="sheet"` docks it to
 * the right edge for editors that sit beside the content they edit.
 */
export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title'> & {
    title: ReactNode
    description?: ReactNode
    footer?: ReactNode
    size?: 'md' | 'lg'
    variant?: 'dialog' | 'sheet'
    /** Header actions placed before the close button. */
    actions?: ReactNode
  }
>(function DialogContent(
  {
    className,
    children,
    title,
    description,
    footer,
    size = 'md',
    variant = 'dialog',
    actions,
    onOpenAutoFocus,
    ...props
  },
  ref
) {
  return (
    <DialogPrimitive.Portal container={portalRoot()}>
      <DialogPrimitive.Overlay className="k-overlay" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(variant === 'sheet' ? 'k-sheet' : 'k-dialog', size === 'lg' && 'k-dialog-lg', className)}
        // Default first focus is the dialog itself, not the Close button (no stray focus ring);
        // pass onOpenAutoFocus to focus a field instead.
        onOpenAutoFocus={
          onOpenAutoFocus ??
          ((event) => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement | null)?.focus()
          })
        }
        {...props}
      >
        <div className="k-dialog-header">
          <div>
            <DialogPrimitive.Title className="k-title">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="k-description">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only" />
            )}
          </div>
          {actions}
          <DialogPrimitive.Close asChild>
            <IconButton label="Close" size="sm">
              <X />
            </IconButton>
          </DialogPrimitive.Close>
        </div>
        <div className="k-dialog-body">{children}</div>
        {footer && <div className="k-dialog-footer">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

/** Confirmation for destructive or irreversible actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  busy
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  onConfirm: () => void
  busy?: boolean
}): ReactNode {
  return (
    <AlertPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertPrimitive.Portal container={portalRoot()}>
        <AlertPrimitive.Overlay className="k-overlay" />
        <AlertPrimitive.Content className="k-dialog" style={{ maxWidth: '24rem' }}>
          <div className="k-dialog-header">
            <div>
              <AlertPrimitive.Title className="k-title">{title}</AlertPrimitive.Title>
              {description && (
                <AlertPrimitive.Description className="k-description">{description}</AlertPrimitive.Description>
              )}
            </div>
          </div>
          <div className="k-dialog-footer" style={{ borderTop: 0, background: 'transparent', paddingTop: 'var(--k-space-2)' }}>
            <AlertPrimitive.Cancel className="k-button k-button-secondary">{cancelLabel}</AlertPrimitive.Cancel>
            <AlertPrimitive.Action
              className={cn('k-button', tone === 'danger' ? 'k-button-danger' : 'k-button-primary')}
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                onConfirm()
              }}
            >
              {confirmLabel}
            </AlertPrimitive.Action>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  )
}
