import { createContext } from 'react'

/** The element inside a panel's title bar that a panel may fill with its own controls. */
export const TitleBarSlotContext = createContext<HTMLElement | null>(null)
