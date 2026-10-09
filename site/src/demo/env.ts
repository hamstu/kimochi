import { useEffect, useState, type RefObject } from 'react'

const DARK = '(prefers-color-scheme: dark)'

function resolveTheme(): 'light' | 'dark' {
  const forced = document.documentElement.getAttribute('data-theme')
  if (forced === 'light' || forced === 'dark') return forced
  return matchMedia(DARK).matches ? 'dark' : 'light'
}

/** The site's resolved theme: `data-theme` on <html> when forced, else the OS preference. */
export function useResolvedTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(resolveTheme)
  useEffect(() => {
    const update = (): void => setTheme(resolveTheme())
    const media = matchMedia(DARK)
    media.addEventListener('change', update)
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      media.removeEventListener('change', update)
      observer.disconnect()
    }
  }, [])
  return theme
}

export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const update = (): void => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

/** Whether the element is on screen (with a margin) and the tab is visible. */
export function useOnScreen(ref: RefObject<Element | null>, rootMargin = '0px'): boolean {
  const [inView, setInView] = useState(false)
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, rootMargin])
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return inView && visible
}

export type Platform = 'macos' | 'windows' | 'linux' | 'deck'

/** The visitor's desktop OS, for the initial tab. */
export function guessPlatform(): Platform {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Linux|X11|CrOS/i.test(ua) && !/Android/i.test(ua)) return 'linux'
  return 'macos'
}
