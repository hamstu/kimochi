import { useCallback, useSyncExternalStore } from 'react'

/**
 * Browser-only values that are safe to render on prerendered pages. While React hydrates the
 * build's static HTML it uses `server` (what the prerender rendered), then re-renders with the
 * browser's value; after that, and on client-side navigation, it reads the browser directly.
 * `read` must return a primitive (or the same object) for the same state.
 */

const never = (): (() => void) => () => undefined

/** A value read once from the browser, e.g. the user agent's platform. */
export function useClientValue<T>(read: () => T, server: T): T {
  return useSyncExternalStore(never, read, () => server)
}

/** A live media query (`(min-width: 1024px)`, `(prefers-reduced-motion: reduce)`). */
export function useMediaQuery(query: string, server = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query]
  )
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => server)
}
