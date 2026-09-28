/** Diagnostic-only timeline. No pixels, text, persistent text hashes or endpoint URLs. */
import { classify, identityKey, stabilityKey, type Observation } from './observation.js'

export type TraceRecord = Record<string, unknown>
interface Input {
  frameId: number
  generation: number
  fingerprint: string | null
  observation: Observation | null
  captureMs: number
  resolveMs?: number
  acquisitionMs?: number
  pixelsMs?: number
  observerMs?: number
  selectionMs?: number
  roundTripMs: number
  width: number
  height: number
}

/** Session-local, bounded intern table: IDs reveal equality, not the original string. */
class Ids {
  private values = new Map<string, number>()
  private next = 0
  get(value: string): number {
    const known = this.values.get(value)
    if (known !== undefined) return known
    const id = ++this.next
    this.values.set(value, id)
    if (this.values.size > 512) this.values.delete(this.values.keys().next().value!)
    return id
  }
}

export function editSummary(before: string, after: string): TraceRecord {
  const a = Array.from(before),
    b = Array.from(after)
  let prefix = 0,
    suffix = 0
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++
  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++
  const removed = a.slice(prefix, a.length - suffix),
    added = b.slice(prefix, b.length - suffix)
  return {
    prefixChars: prefix,
    removedChars: removed.length,
    addedChars: added.length,
    numericOnly:
      removed.length + added.length > 0 && [...removed, ...added].every((c) => /\p{N}/u.test(c))
  }
}

export class ScanTrace {
  readonly session: string
  private seq = 0
  private ids = new Ids()
  private previous: Input | null = null
  private lastCaptureAt: number | null = null
  private queue: TraceRecord[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private sending = false
  private dropped = 0
  private started: number

  constructor(
    private send: (records: TraceRecord[]) => Promise<unknown>,
    private now = Date.now,
    session?: string
  ) {
    this.session = session ?? crypto.randomUUID()
    this.started = now()
  }

  record(kind: string, data: TraceRecord = {}): void {
    if (this.queue.length >= 256) {
      this.dropped++
      return
    }
    const at = this.now()
    this.queue.push({
      ...data,
      schema: 1,
      session: this.session,
      seq: ++this.seq,
      at,
      elapsedMs: at - this.started,
      kind
    })
    if (!this.timer && !this.sending)
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, 1000)
  }

  /** Diagnostic failure can neither throw into nor wait in the OCR pipeline. */
  async flush(): Promise<void> {
    if (this.sending || !this.queue.length) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.sending = true
    const records = this.queue.splice(0, 64)
    const dropped = this.dropped
    this.dropped = 0
    if (dropped) records[0].droppedRecords = dropped
    try {
      await this.send(records)
    } catch {
      this.dropped += records.length + dropped
    } finally {
      this.sending = false
      if (this.queue.length && !this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          void this.flush()
        }, 1000)
    }
  }

  observation(input: Input): void {
    const before = this.previous?.generation === input.generation ? this.previous : null
    const current = input.observation
    const old = before?.observation
    const text = current?.text ?? ''
    const previousText = old?.text ?? ''
    const key = stabilityKey(text),
      oldKey = stabilityKey(previousText)
    const at = this.now()
    // Pair by reading-order index, not guessed semantic identity. Rewrapping or
    // inserted lines can shift indices; aggregate text IDs remain independent.
    const changes: TraceRecord[] = []
    const lines = current?.lines ?? [],
      oldLines = old?.lines ?? []
    let changedLines = 0
    for (let index = 0; index < Math.max(lines.length, oldLines.length); index++) {
      const a = oldLines[index],
        b = lines[index]
      if (a?.text === b?.text && JSON.stringify(a?.box) === JSON.stringify(b?.box)) continue
      changedLines++
      if (changes.length >= 40) continue
      changes.push({
        index,
        beforeId: a ? this.ids.get(a.text) : null,
        afterId: b ? this.ids.get(b.text) : null,
        beforeBox: a?.box ?? null,
        afterBox: b?.box ?? null,
        normalizedTextChanged: stabilityKey(a?.text ?? '') !== stabilityKey(b?.text ?? ''),
        ...editSummary(a?.text ?? '', b?.text ?? '')
      })
    }
    this.record('first-pass', {
      frameId: input.frameId,
      generation: input.generation,
      width: input.width,
      height: input.height,
      captureMs: input.captureMs,
      resolveMs: input.resolveMs,
      acquisitionMs: input.acquisitionMs,
      pixelsMs: input.pixelsMs,
      observerMs: input.observerMs,
      roundTripMs: input.roundTripMs,
      selectionMs: input.selectionMs,
      completionGapMs: this.lastCaptureAt === null ? null : at - this.lastCaptureAt,
      pixelsChanged:
        before?.fingerprint && input.fingerprint ? before.fingerprint !== input.fingerprint : null,
      observationAvailable: current !== null,
      rawTextId: current ? this.ids.get(text) : null,
      normalizedTextId: current ? this.ids.get(key) : null,
      identityTextId: current ? this.ids.get(identityKey(text)) : null,
      relation: current ? classify(old ? oldKey : null, key) : 'unavailable',
      rawTextChanged: old ? previousText !== text : null,
      normalizedTextChanged: old ? oldKey !== key : null,
      chars: Array.from(text).length,
      lines: lines.length,
      changedLines,
      truncatedLines: Math.max(0, changedLines - changes.length),
      changes,
      ...editSummary(previousText, text)
    })
    this.lastCaptureAt = at
    this.previous = input
  }

  result(frameId: number, text: string, durationMs: number): void {
    this.record('second-pass-end', {
      frameId,
      durationMs,
      chars: Array.from(text).length,
      textId: this.ids.get(identityKey(text)),
      empty: identityKey(text) === ''
    })
  }
}
