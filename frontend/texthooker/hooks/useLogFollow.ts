import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { followAfterScroll, USER_SCROLL_MS } from '@texthooker/lib/logFollow'

interface LogFollow {
  /** The Log's scrolling box. */
  scroll: RefObject<HTMLElement | null>
  /** Whether the Log follows new lines now. */
  following: () => boolean
  /** Starts (another session opened) or stops (a line revealed) following. */
  setFollowing: (value: boolean) => void
  /** Scrolls to the end when following and not held; `force` scrolls there regardless. */
  toEnd: (force?: boolean) => void
  /** The lines changed: to the end when following, else the rows in view stay where they are. */
  settle: () => void
  /** The scrolling box's `onScroll`. */
  onScroll: () => void
}

/**
 * Keeps the Log at its end while the reader is at or near it (lib/logFollow.ts). The box is
 * scrolled to the end whenever it or its content (`contentSelector`, inside it) changes size while
 * following: a line laid out taller (furigana, a wrap), a screenshot loading, a note, the window
 * resized or shown again. New lines whose rows add no height (one line in, the oldest trimmed at the
 * line limit) are the caller's to report, with `settle()`.
 *
 * Not following, the rows in view stay put as rows come and go above them (the oldest dropped as
 * new ones arrive, earlier ones shown): the first row in view is remembered and kept at its place.
 * The browser's own scroll anchoring would do this, but the Log's row updates suppress it. While
 * `held` (the reader is picking rows in selection mode), the rows stay put the same way, even at
 * the end; when the hold ends, a following Log goes to its end.
 */
export function useLogFollow(contentSelector: string, threshold: number, held: boolean): LogFollow {
  const scroll = useRef<HTMLElement>(null)
  const follow = useRef(true)
  const lastTop = useRef(0)
  /** When the reader last used the wheel, touch, a key or the pointer (held: until released). */
  const userAt = useRef(0)
  const pointerHeld = useRef(false)
  /** The box is hidden (another view covers the Log): its scroll positions mean nothing then. */
  const hidden = useRef(false)
  /** The first row in view (`data-line-id`), its offset from the box's top, and the box's
      `scrollTop` then: kept in place only while nothing has scrolled the box since. */
  const anchor = useRef<{ row: string; offset: number; top: number } | null>(null)
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

  const remember = useCallback(() => {
    const el = scroll.current
    anchor.current = null
    if (!el || hidden.current || (follow.current && !heldRef.current)) return
    const rows = el.querySelectorAll<HTMLElement>(`${contentSelector} [data-line-id]`)
    const view = el.getBoundingClientRect().top
    // The rows run top to bottom: find the first whose bottom is below the box's top.
    let lo = 0
    let hi = rows.length - 1
    let first = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (rows[mid].getBoundingClientRect().bottom > view) {
        first = mid
        hi = mid - 1
      } else lo = mid + 1
    }
    if (first === -1) return
    const row = rows[first]
    anchor.current = {
      row: row.dataset.lineId ?? '',
      offset: row.getBoundingClientRect().top - view,
      top: el.scrollTop
    }
  }, [contentSelector])

  const toEnd = useCallback(
    (force = false) => {
      const el = scroll.current
      if (!el || hidden.current) return
      if (!force && (!follow.current || heldRef.current)) return
      el.scrollTop = el.scrollHeight
      lastTop.current = el.scrollTop
      remember()
    },
    [remember]
  )

  const settle = useCallback(() => {
    const el = scroll.current
    if (!el || hidden.current) return
    if (follow.current && !heldRef.current) return toEnd()
    const a = anchor.current
    // Only the layout moved since (a scroll by the reader, a reveal, or the browser's own anchoring
    // changes `scrollTop`, and then the view is where it should be).
    if (a && el.scrollTop === a.top) {
      const row = el.querySelector(`${contentSelector} [data-line-id="${CSS.escape(a.row)}"]`)
      if (row) {
        const shift = row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset
        if (Math.abs(shift) >= 1) {
          el.scrollTop += shift
          lastTop.current = el.scrollTop
        }
        // The same row at the same place: `scrollTop` lands on whole device pixels, so measuring
        // afresh would add the rounding up over many lines.
        anchor.current = { ...a, top: el.scrollTop }
        return
      }
    }
    remember()
  }, [contentSelector, toEnd, remember])

  const onScroll = useCallback(() => {
    const el = scroll.current
    if (!el || hidden.current || el.clientHeight === 0) return
    const byUser = pointerHeld.current || performance.now() - userAt.current < USER_SCROLL_MS
    follow.current = followAfterScroll(el, lastTop.current, follow.current, thresholdRef.current, byUser)
    lastTop.current = el.scrollTop
    // The scroll was ours, keeping the remembered row in place: it is still where it was.
    if (anchor.current?.top !== el.scrollTop) remember()
  }, [remember])

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
      settle()
    })
    observer.observe(el)
    const content = el.querySelector(contentSelector)
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [contentSelector, settle])

  // The reader's own scrolling: only that stops following (the layout moves the view as well).
  useEffect(() => {
    const el = scroll.current
    if (!el) return
    const mark = () => {
      userAt.current = performance.now()
    }
    const down = () => {
      pointerHeld.current = true
      mark()
    }
    const up = () => {
      if (!pointerHeld.current) return
      pointerHeld.current = false
      mark()
    }
    const options = { passive: true }
    el.addEventListener('wheel', mark, options)
    el.addEventListener('touchmove', mark, options)
    el.addEventListener('keydown', mark)
    // The scrollbar, or a text selection dragged past the edge, scrolls while the button is down.
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    // Scroll keys reach the window when nothing in the Log has focus.
    window.addEventListener('keydown', mark)
    return () => {
      el.removeEventListener('wheel', mark)
      el.removeEventListener('touchmove', mark)
      el.removeEventListener('keydown', mark)
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', mark)
    }
  }, [])

  // The hold ended: catch up with the lines that came in meanwhile.
  useLayoutEffect(() => {
    if (held) remember()
    else if (follow.current) toEnd()
  }, [held, toEnd, remember])

  return { scroll, following, setFollowing, toEnd, settle, onScroll }
}
