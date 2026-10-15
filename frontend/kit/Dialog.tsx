import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as AlertPrimitive from '@radix-ui/react-alert-dialog'
import { X } from 'lucide-react'
import { cn, portalRoot } from './cn'
import { IconButton } from './Button'
import { isComposing } from './ime'

export const Dialog = DialogPrimitive.Root

/**
 * Centres a dialog: a full-window grid around it, not auto margins on the dialog itself. WebKit on
 * macOS 26 paints parts of a `position: fixed; inset: 0; margin: auto` box at a wrong offset while
 * its contents move (dragging rows in Manage sessions); it also avoids a translate, which can blur
 * text on fractional pixels. Clicks pass through the frame to the overlay.
 */
function DialogFrame({ children }: { children: ReactNode }): ReactNode {
  return <div className="k-dialog-frame">{children}</div>
}
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
    onEscapeKeyDown,
    ...props
  },
  ref
) {
  const content = (
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
      // Escape that cancels an IME conversion in a field must not close the dialog.
      onEscapeKeyDown={(event) => {
        if (isComposing(event)) event.preventDefault()
        else onEscapeKeyDown?.(event)
      }}
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
  )
  return (
    <DialogPrimitive.Portal container={portalRoot()}>
      <DialogPrimitive.Overlay className="k-overlay" />
      {/* A sheet docks to the right edge itself; a dialog is centred by its frame. */}
      {variant === 'sheet' ? content : <DialogFrame>{content}</DialogFrame>}
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
  busy,
  dismissOnOutsideClick
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
  /** A click outside cancels, like Escape. Off by default: an alert dialog wants an answer. */
  dismissOnOutsideClick?: boolean
}): ReactNode {
  return (
    <AlertPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertPrimitive.Portal container={portalRoot()}>
        <AlertPrimitive.Overlay
          className="k-overlay"
          onClick={dismissOnOutsideClick ? () => onOpenChange(false) : undefined}
        />
        <DialogFrame>
          <AlertPrimitive.Content
            className="k-dialog"
            style={{ maxWidth: '24rem' }}
            onEscapeKeyDown={(event) => {
              if (isComposing(event)) event.preventDefault()
            }}
          >
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
        </DialogFrame>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  )
}
