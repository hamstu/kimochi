/**
 * The activity feed: short, plain sentences about what the app is doing, for the ticker at the
 * foot of the Log.
 *
 * A scan used to be silent between the trigger and the line appearing, and silent for good when
 * nothing appeared: OCR failed, the text was a repeat, the frame was replaced, the model was still
 * downloading. Each of those already had a log record or a status string somewhere; this is the
 * one place they are said to the reader.
 *
 * Anything can post, from any window or from Rust (`activity_post`, the `activity` event). Each
 * window keeps its own feed in memory for its lifetime; nothing is persisted. Two rules keep it
 * quiet enough to leave on screen:
 *
 * - **Repeats coalesce.** A post that says exactly what the newest entry says bumps its count
 *   instead of adding a row, the way a browser console folds identical messages.
 * - **Work in progress settles.** A `busy` entry is a promise of an outcome. A later post with
 *   the same `key` replaces it: another `busy` updates it in place (progress), anything else
 *   retires it and becomes the newest entry (the outcome).
 */

export type ActivityTone = 'info' | 'busy' | 'ok' | 'warn' | 'error'

export const ACTIVITY_TONES: readonly ActivityTone[] = ['info', 'busy', 'ok', 'warn', 'error']

export interface ActivityPost {
  text: string
  tone?: ActivityTone
  /** What this is about ('scan', 'model:meikiocr'); a later post with the same key settles a busy one. */
  key?: string | null
  /** Epoch ms; now when omitted. */
  at?: number
}

export interface ActivityEntry {
  id: number
  text: string
  tone: ActivityTone
  /** When it first happened. */
  at: number
  /** How many times in a row it has happened. */
  count: number
  /** When it last happened. */
  lastAt: number
  key?: string
  /** Each occurrence, oldest first, for the expanded row; capped at `ACTIVITY_TIMES_LIMIT`. */
  times: number[]
}

/** How many entries a feed keeps. */
export const ACTIVITY_LIMIT = 200
/** How many occurrences a coalesced entry remembers individually. */
export const ACTIVITY_TIMES_LIMIT = 50
/** Longest message kept; a pasted stack trace is not a status line. */
export const ACTIVITY_TEXT_LIMIT = 300

/** One line of plain text, or '' when there is nothing to say. */
export function activityText(text: unknown): string {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > ACTIVITY_TEXT_LIMIT ? `${flat.slice(0, ACTIVITY_TEXT_LIMIT - 1)}…` : flat
}

/** A post from an event payload or an untyped caller, or null when it is not one. */
export function normalizeActivity(raw: unknown): ActivityPost | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const text = activityText(r.text)
  if (!text) return null
  const tone = ACTIVITY_TONES.includes(r.tone as ActivityTone) ? (r.tone as ActivityTone) : 'info'
  const key = typeof r.key === 'string' && r.key ? r.key : null
  const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : undefined
  return { text, tone, key, ...(at === undefined ? {} : { at }) }
}

function lastIndex<T>(list: readonly T[], match: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (match(list[i])) return i
  return -1
}

const replaced = <T>(list: readonly T[], index: number, item: T): T[] =>
  list.map((old, i) => (i === index ? item : old))

const sameKey = (a: string | undefined, b: string | null | undefined): boolean => (a ?? null) === (b ?? null)

/**
 * One window's feed. Entries are replaced, never mutated, so a snapshot can be compared by
 * identity (React's `useSyncExternalStore`).
 */
export class ActivityFeed {
  private list: readonly ActivityEntry[] = []
  private nextId = 1
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly limit = ACTIVITY_LIMIT,
    private readonly now: () => number = Date.now
  ) {}

  /** Oldest first. */
  entries = (): readonly ActivityEntry[] => this.list

  latest(): ActivityEntry | null {
    return this.list.at(-1) ?? null
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Record a post; returns the entry that now carries it, or null for an empty message. */
  post(input: ActivityPost): ActivityEntry | null {
    const text = activityText(input.text)
    if (!text) return null
    const tone = input.tone ?? 'info'
    const key = input.key || undefined
    const at = input.at ?? this.now()
    let list = this.list

    // A busy entry with this key is settled by this post.
    if (key !== undefined) {
      const index = lastIndex(list, (entry) => entry.key === key && entry.tone === 'busy')
      if (index >= 0) {
        if (tone === 'busy') {
          // Progress: the same piece of work, so the same row, updated where it stands.
          const busy = list[index]
          if (busy.text === text) return busy
          const updated = { ...busy, text, lastAt: at }
          return this.commit(replaced(list, index, updated), updated)
        }
        list = list.filter((_, i) => i !== index)
      }
    }

    const newest = list.at(-1)
    if (newest && newest.text === text && newest.tone === tone && sameKey(newest.key, key)) {
      const times = [...newest.times, at].slice(-ACTIVITY_TIMES_LIMIT)
      const coalesced = { ...newest, count: newest.count + 1, lastAt: at, times }
      return this.commit(replaced(list, list.length - 1, coalesced), coalesced)
    }

    const entry: ActivityEntry = {
      id: this.nextId++,
      text,
      tone,
      at,
      count: 1,
      lastAt: at,
      ...(key === undefined ? {} : { key }),
      times: [at]
    }
    return this.commit([...list, entry].slice(-this.limit), entry)
  }

  private commit(list: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry {
    this.list = list
    for (const listener of this.listeners) listener()
    return entry
  }
}

/** "just now", "4 s ago", "2 min ago", "3 h ago", "2 d ago". */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.floor((now - at) / 1000)
  if (seconds < 3) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** How often a relative time needs redrawing to stay true: every second for the first minute. */
export function relativeTimeRefreshMs(at: number, now: number): number {
  return now - at < 60_000 ? 1000 : 15_000
}
