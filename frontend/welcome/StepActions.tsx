/**
 * The onboarding action bar's right-hand side. The window owns the bar (Back, the step dots);
 * each step renders its own buttons into it with `StepActions`, so a step's actions live beside
 * the state that drives them. Order them secondary first, primary last: the primary sits at the
 * bar's right edge.
 */
import { useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { StepActionsSlot } from './stepActionsSlot'

export function StepActions({ children }: { children: ReactNode }): ReactNode {
  const slot = useContext(StepActionsSlot)
  return slot ? createPortal(children, slot) : null
}
