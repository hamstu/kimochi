/**
 * Opening Settings at one section, not just its page: the asker names the section (its element
 * id), the page scrolls it into view once it shows, smoothly, and marks it for a moment. Pages
 * opt in with `useSettingsTarget`. Same window only (the main window's Settings view).
 */
import { useEffect } from 'react'

/** Settings → Log & Sessions → Activity ticker (the ticker's cog opens it). */
export const ACTIVITY_TICKER_SECTION = 'settings-activity-ticker'

/** Settings → Text Hooker → Card style (Settings → Overlay → Text Hooker card's button opens it). */
export const HOOK_CARD_SECTION = 'settings-texthooker-card'

let pending: string | null = null
const subs = new Set<() => void>()

/** Asks the next Settings page that shows (or the one showing) to bring `id` into view. */
export function requestSettingsSection(id: string): void {
  pending = id
  for (const fn of subs) fn()
}

/** For a Settings page: scroll to a requested section of it when there is one. */
export function useSettingsTarget(): void {
  useEffect(() => {
    let frame = 0
    const reveal = (): void => {
      const id = pending
      if (!id) return
      cancelAnimationFrame(frame)
      // After the page has laid out (and the view has put it at its top).
      frame = requestAnimationFrame(() => {
        const target = document.getElementById(id)
        if (!target) return
        pending = null
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
        target.removeAttribute('data-settings-target')
        void target.offsetWidth
        target.setAttribute('data-settings-target', '')
        window.setTimeout(() => target.removeAttribute('data-settings-target'), 2200)
      })
    }
    subs.add(reveal)
    reveal()
    return () => {
      subs.delete(reveal)
      cancelAnimationFrame(frame)
    }
  }, [])
}
