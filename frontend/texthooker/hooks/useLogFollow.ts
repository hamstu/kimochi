import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { followAfterScroll } from '@texthooker/lib/logFollow'

interface LogFollow {
  /** The Log's scrolling box. */
  scroll: RefObject<HTMLElement | null>
  /** Whether the Log follows new lines now. */
  following: () => boolean
  /** Starts (another session opened) or stops (a line revealed) following. */
  setFollowing: (value: boolean) => void
  /** Scrolls to the end when following and not held; `force` scrolls there regardless. */
  toEnd: (force?: boolean) => void
  /** The scrolling box's `onScroll`. */
  onScroll: () => void
}

/**
 * Keeps the Log at its end while the reader is at or near it (lib/logFollow.ts). The box is
 * scrolled to the end whenever it or its content (`contentSelector`, inside it) changes size while
 * following: a line laid out taller (furigana, a wrap), a screenshot loading, a note, the window
 * resized or shown again. New lines whose rows add no height (one line in, the oldest trimmed at the
 * line limit) are the caller's to report, with `toEnd()`.
 *
 * While `held` (the reader is picking rows in selection mode), nothing moves under the pointer;
 * when the hold ends, a following Log goes to its end.
 */
export function useLogFollow(contentSelector: string, threshold: number, held: boolean): LogFollow {
  const scroll = useRef<HTMLElement>(null)
  const follow = useRef(true)
  const lastTop = useRef(0)
  /** The box is hidden (another view covers the Log): its scroll positions mean nothing then. */
  const hidden = useRef(false)
  const heldRef = useRef(held)
  const thresholdRef = useRef(threshold)
  useLayoutEffect(() => {
    heldRef.current = held
    thresholdRef.current = threshold
  })

  const following = useCallback(() => follow.current, [])
  const setFollowing = useCallback((value: boolean) => {
    follow.current = value
  }, [])

  const toEnd = useCallback((force = false) => {
    const el = scroll.current
    if (!el || hidden.current) return
    if (!force && (!follow.current || heldRef.current)) return
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }, [])

  const onScroll = useCallback(() => {
    const el = scroll.current
    if (!el || hidden.current || el.clientHeight === 0) return
    follow.current = followAfterScroll(el, lastTop.current, follow.current, thresholdRef.current)
    lastTop.current = el.scrollTop
  }, [])

  useEffect(() => {
    const el = scroll.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (el.clientHeight === 0) {
        hidden.current = true
        return
      }
      if (hidden.current) {
        hidden.current = false
        // Shown again: a reader who had scrolled up finds their place where they left it.
        if (!follow.current && el.scrollTop !== lastTop.current) el.scrollTop = lastTop.current
      }
      toEnd()
    })
    observer.observe(el)
    const content = el.querySelector(contentSelector)
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [contentSelector, toEnd])

  // The hold ended: catch up with the lines that came in meanwhile.
  useLayoutEffect(() => {
    if (!held) toEnd()
  }, [held, toEnd])

  return { scroll, following, setFollowing, toEnd, onScroll }
}
