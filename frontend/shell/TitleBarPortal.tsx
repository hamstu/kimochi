/**
 * Renders its children into the window's title bar, between the title and the window buttons.
 * The title bar stays one drag region; buttons inside it opt out of dragging on their own.
 */
import { useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { TitleBarSlotContext } from './titleBarSlot'

export function TitleBarPortal({ children }: { children: ReactNode }): ReactNode {
  const slot = useContext(TitleBarSlotContext)
  return slot ? createPortal(children, slot) : null
}
