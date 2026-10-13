import { createContext } from 'react'

/** The element in the onboarding action bar that the current step fills with its buttons. */
export const StepActionsSlot = createContext<HTMLElement | null>(null)
