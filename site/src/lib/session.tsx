import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, type User } from './api'

export type SessionStatus = 'loading' | 'signed-in' | 'signed-out'

export interface Session {
  status: SessionStatus
  user: User | null
  /** True when the last `/api/auth/me` failed for a reason other than "not signed in". */
  unreachable: boolean
  /** Re-read the signed-in user from the server. */
  refresh: () => Promise<User | null>
  /** Replace the user after an endpoint returned one (sign-in, profile edit), or null on sign-out. */
  setUser: (user: User | null) => void
}

const SessionContext = createContext<Session | null>(null)

/** Holds the web session's user (GET /api/auth/me). Wraps every route in App.tsx. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null)
  const [status, setStatus] = useState<SessionStatus>('loading')
  const [unreachable, setUnreachable] = useState(false)

  const setUser = useCallback((next: User | null) => {
    setUserState(next)
    setStatus(next ? 'signed-in' : 'signed-out')
    setUnreachable(false)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const me = await api.me()
      setUser(me)
      return me
    } catch (err) {
      setUserState(null)
      setStatus('signed-out')
      setUnreachable(!(err instanceof ApiError && err.status === 401))
      return null
    }
  }, [setUser])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo(
    () => ({ status, user, unreachable, refresh, setUser }),
    [status, user, unreachable, refresh, setUser]
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
