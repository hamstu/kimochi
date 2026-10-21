import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import { useClientValue, useMediaQuery } from '../lib/client'

const DARK = '(prefers-color-scheme: dark)'

function resolveTheme(): 'light' | 'dark' {
  const forced = document.documentElement.getAttribute('data-theme')
  if (forced === 'light' || forced === 'dark') return forced
  return matchMedia(DARK).matches ? 'dark' : 'light'
}

function subscribeTheme(update: () => void): () => void {
  const media = matchMedia(DARK)
  media.addEventListener('change', update)
  const observer = new MutationObserver(update)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => {
    media.removeEventListener('change', update)
    observer.disconnect()
  }
}

/**
 * The site's resolved theme: `data-theme` on <html> when forced, else the OS preference ("light"
 * in prerendered HTML).
 */
export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeTheme, resolveTheme, () => 'light')
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)')
}

function subscribeVisibility(update: () => void): () => void {
  document.addEventListener('visibilitychange', update)
  return () => document.removeEventListener('visibilitychange', update)
}

/** Whether the element is on screen (with a margin) and the tab is visible. */
export function useOnScreen(ref: RefObject<Element | null>, rootMargin = '0px'): boolean {
  const [inView, setInView] = useState(false)
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'visible', () => true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, rootMargin])
  return inView && visible
}

export type Platform = 'macos' | 'windows' | 'linux' | 'deck'

/** The visitor's desktop OS, for the initial tab ("macos" in prerendered HTML). */
export function useGuessedPlatform(): Platform {
  return useClientValue(guessPlatform, 'macos')
}

function guessPlatform(): Platform {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Linux|X11|CrOS/i.test(ua) && !/Android/i.test(ua)) return 'linux'
  return 'macos'
}
