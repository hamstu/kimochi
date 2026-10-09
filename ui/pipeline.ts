/**
 * Guarding a scan against the selection changing underneath it.
 *
 * A cloud OCR request has a 45-second timeout, and local backends can be slower
 * still. In that window the user can pick a different source, commit a new crop
 * in the picker, or clear the overlay. Without a guard the late result is
 * attributed to whatever is selected *now*: old pixels labelled with a new
 * source's app name, a stale crop's text published to history, or text the user
 * just cleared reappearing seconds later.
 *
 * So every scan captures its own selection up front and carries a generation
 * number. Anything that invalidates in-flight work bumps the generation, and a
 * result from an older generation is dropped before it can render or publish.
 */

export interface Selection {
  sourceId: string | null
  applicationContextId?: string | null
  crop: unknown
}

export interface ScanJob<Request = unknown, Source = unknown> {
  generation: number
  request: Request
  source: Source | null
  sourceId: string | null
}

/** Stable identity for a selection, so a change can be detected by comparison. */
export function selectionKey(selection: Selection): string {
  const crop = selection.crop
    ? JSON.stringify(selection.crop, Object.keys(selection.crop as object).sort())
    : 'full'
  return `${selection.sourceId ?? 'none'}|${crop}|${selection.applicationContextId ?? ''}`
}

export function sameSelection(a: Selection, b: Selection): boolean {
  return selectionKey(a) === selectionKey(b)
}

export class Generation {
  private value = 0

  get current(): number {
    return this.value
  }

  /** Invalidate every scan currently in flight. */
  bump(): number {
    return ++this.value
  }

  /** Bump only if the selection actually changed; returns true when it did. */
  bumpIfChanged(previous: Selection | null, next: Selection): boolean {
    if (previous && sameSelection(previous, next)) return false
    this.bump()
    return true
  }

  isStale(job: { generation: number }): boolean {
    return job.generation !== this.value
  }
}

/**
 * A skip-if-held mutex shared by the manual and automatic paths.
 *
 * Both drive the same single-threaded resources — one native capture mutex, one
 * recognition worker — so overlapping them produces duplicate work and interleaved
 * results rather than more throughput. Skipping is the right failure mode here:
 * the automatic loop will come round again in well under a second.
 */
export class PipelineLock {
  private held = false

  get isHeld(): boolean {
    return this.held
  }

  acquire(): boolean {
    if (this.held) return false
    this.held = true
    return true
  }

  release(): void {
    this.held = false
  }

  /** Run `work` if the lock is free; resolves to `null` when it is not. */
  async run<T>(work: () => Promise<T>): Promise<T | null> {
    if (!this.acquire()) return null
    try {
      return await work()
    } finally {
      this.release()
    }
  }
}
