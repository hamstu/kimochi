import { createContext, useContext } from 'react'

/** Destructive session actions, confirmed by one set of dialogs owned by the main window. */
export interface LogActions {
  clearLines: () => void
  resetStats: () => void
  deleteSession: () => void
  editSession: () => void
  manageSessions: () => void
}

export const LogActionsContext = createContext<LogActions | null>(null)

export function useLogActions(): LogActions {
  const actions = useContext(LogActionsContext)
  if (!actions) throw new Error('useLogActions must be used inside LogActionsProvider')
  return actions
}
