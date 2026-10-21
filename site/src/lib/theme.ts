import { useCallback, useState } from 'react'
import { useClientValue } from './client'

/** The user's appearance choice. `system` follows prefers-color-scheme. */
export type ThemeChoice = 'system' | 'light' | 'dark'

/** Keep in sync with the inline pre-paint script in site/index.html. */
export const THEME_STORAGE_KEY = 'kimochi-site-theme'

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function apply(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
}

/**
 * Theme choice, persisted in localStorage and reflected as `data-theme` on <html>. The stored
 * choice is already on <html> before first paint (index.html), so it is only applied on change.
 */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const stored = useClientValue(readStored, 'system')
  const [picked, setPicked] = useState<ThemeChoice | null>(null)
  const choice = picked ?? stored

  const set = useCallback((next: ThemeChoice) => {
    setPicked(next)
    apply(next)
    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
      else localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Storage blocked (private mode etc.): the choice still applies for this page view.
    }
  }, [])

  return [choice, set]
}
