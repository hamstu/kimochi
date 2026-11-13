import { useEffect } from 'react'
import { startNote } from '@texthooker/lib/lineEdit'

/**
 * A, anywhere in the Log while it shows, starts a note at its end: not with a modifier (Shift is scan mode),
 * not while typing, and not while a menu or dialog is open.
 */
export function useAddNoteHotkey(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented) return
      if (e.key.toLowerCase() !== 'a') return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      )
        return
      if (document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]')) return
      e.preventDefault()
      startNote()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
