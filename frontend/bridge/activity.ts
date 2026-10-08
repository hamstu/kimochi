/**
 * This window's activity feed (`ui/activity.ts`), fed by the `activity` event.
 *
 * One feed per window, for the window's lifetime, started on first use. Everything reaches it
 * through the event, this window's own posts included (`activity_post` broadcasts to the
 * poster too), so a post is never recorded twice; only when native cannot be reached at all, as
 * in the UI preview without a handler, does a post go straight into the feed.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  ActivityFeed,
  normalizeActivity,
  relativeTimeRefreshMs,
  type ActivityEntry,
  type ActivityPost
} from '@ui/activity'

export type { ActivityEntry, ActivityPost, ActivityTone } from '@ui/activity'

const feed = new ActivityFeed()
let listening = false

function start(): void {
  if (listening) return
  listening = true
  listen<unknown>('activity', (event) => {
    const post = normalizeActivity(event.payload)
    if (post) feed.post(post)
  }).catch(() => {
    // No event bridge (a page outside the app): local posts still land.
  })
}

/** Post to every window's feed. Never throws; see `postActivity` in `ui/native.js`. */
export function postActivity(post: ActivityPost): void {
  start()
  invoke('activity_post', { text: post.text, tone: post.tone ?? 'info', key: post.key ?? null }).catch(
    () => feed.post(post)
  )
}

/** The feed's entries, oldest first; re-renders on every change. */
export function useActivity(): readonly ActivityEntry[] {
  useEffect(start, [])
  return useSyncExternalStore(feed.subscribe, feed.entries)
}

/**
 * The current time, kept fresh enough for a relative time since `since` to stay true: every
 * second for the first minute, then every fifteen. Stops while `active` is false.
 */
export function useNow(since: number | null, active = true): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (since === null || !active) return
    const tick = (): void => {
      const at = Date.now()
      setNow(at)
      timer = window.setTimeout(tick, relativeTimeRefreshMs(since, at))
    }
    // Straight away, not after the first interval: the clock stood still while inactive.
    let timer = window.setTimeout(tick, 0)
    return () => window.clearTimeout(timer)
  }, [since, active])
  return now
}
