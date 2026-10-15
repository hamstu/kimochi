/**
 * Shift-scan for the Yomitan API pop-up (Kimochi's own), shared by the Log (frontend
 * `useScanMode`) and the overlay (`api-lookup.js`).
 *
 * The caller says where the pointer is while Shift is held (`scan`) and when it is let go
 * (`stop`). The scanner finds the character under the pointer, asks the Yomitan API which word
 * starts there (`/tokenize` over the next 16 characters), selects that word, as Yomitan does, and
 * asks the caller to show it with the word's box, so the pop-up can sit beside the word.
 *
 * Plain DOM with no imports: the overlay loads `ui/` modules as they are, without a bundler.
 */

/** Characters read from the pointer onwards; the longest word Yomitan can match. */
export const SCAN_WINDOW = 16
/** How often the pointer is looked at while it moves. */
const THROTTLE_MS = 25
/** How long the pointer rests on a new word before it is shown. Short: a lookup takes tens of
    milliseconds and a newer one supersedes it, so this only skips the words a fast glide crosses. */
const DWELL_MS = 40

export interface ScanPoint {
  /** In the document's viewport. */
  x: number
  y: number
  /** On the desktop, in the units `show_popover` takes. */
  screenX: number
  screenY: number
}

export interface ScanHit {
  term: string
  /** The text the word was found in (the Anki card's sentence). */
  sentence: string | null
  /** The word's box on the desktop. */
  anchor: { x: number; y: number; width: number; height: number } | null
  point: ScanPoint
  /** Looked up by a click (`lookUp`) rather than by Shift. */
  clicked: boolean
}

export interface ScannerOptions {
  /** A hit must be inside an element matching this. */
  region: string
  /** Reading forward stops at the edge of the closest element matching this. */
  block: string
  /** The sentence for a word found in `node`. */
  sentenceOf: (node: Text) => string | null
  /** The Yomitan API's `/tokenize` for `text`, scanning `scanLength` characters. */
  tokenize: (text: string, scanLength: number) => Promise<unknown>
  /** Open the pop-up. */
  show: (hit: ScanHit) => void
}

interface CaretHit {
  node: Text
  offset: number
}

/** Whether a glyph's box holds the point. Some glyphs (ruby-influenced) give several boxes. */
function glyphHolds(node: Text, index: number, x: number, y: number): boolean {
  if (index < 0 || index >= node.data.length) return false
  const range = document.createRange()
  try {
    range.setStart(node, index)
    range.setEnd(node, index + 1)
  } catch {
    return false
  }
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width === 0 && rect.height === 0) continue
    if (x >= rect.left && x < rect.right && y >= rect.top - 1 && y <= rect.bottom + 1) return true
  }
  return false
}

/**
 * The text node and offset of the glyph under (x, y). The browser's caret lookup finds a nearby
 * text node; the glyphs around the caret are then tested against their own boxes, horizontal or
 * vertical text alike, since the caret is often one glyph off.
 */
export function caretFromPoint(x: number, y: number): CaretHit | null {
  type CaretFn = (x: number, y: number) => { offsetNode: Node; offset: number } | null
  const position = (document as Document & { caretPositionFromPoint?: CaretFn }).caretPositionFromPoint
  let node: Text | null = null
  let caret = 0
  if (typeof position === 'function') {
    const p = position.call(document, x, y)
    if (p?.offsetNode?.nodeType === Node.TEXT_NODE) {
      node = p.offsetNode as Text
      caret = p.offset
    }
  } else {
    const r = document.caretRangeFromPoint?.(x, y)
    if (r?.startContainer?.nodeType === Node.TEXT_NODE) {
      node = r.startContainer as Text
      caret = r.startOffset
    }
  }
  if (!node) return null
  // Most likely first: the glyph ending at the caret, the one starting there, then outwards.
  for (let d = 0; d <= 4; d++) {
    if (glyphHolds(node, caret - 1 - d, x, y)) return { node, offset: caret - 1 - d }
    if (d > 0 && glyphHolds(node, caret - 1 + d, x, y)) return { node, offset: caret - 1 + d }
  }
  return null
}

/** The text nodes after `start` inside `block`, skipping ruby readings. */
function* following(start: Text, block: Element): Generator<Text> {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let passed = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === start) {
      passed = true
      continue
    }
    if (!passed || n.parentElement?.nodeName === 'RT') continue
    yield n as Text
  }
}

/** Up to `length` characters from (start, offset), across text nodes within `block`. */
export function readForward(start: Text, offset: number, length: number, block: Element | null): string {
  let out = start.data.slice(offset)
  if (out.length >= length || !block) return out.slice(0, length)
  for (const node of following(start, block)) {
    out += node.data
    if (out.length >= length) break
  }
  return out.slice(0, length)
}

/** A Range over exactly `length` characters from (start, offset), or null if they run out. */
export function forwardRange(start: Text, offset: number, length: number, block: Element | null): Range | null {
  const range = document.createRange()
  range.setStart(start, offset)
  const first = Math.min(start.data.length - offset, length)
  range.setEnd(start, offset + first)
  let remaining = length - first
  if (remaining === 0) return range
  if (!block) return null
  for (const node of following(start, block)) {
    const take = Math.min(node.data.length, remaining)
    range.setEnd(node, take)
    remaining -= take
    if (remaining === 0) return range
  }
  return null
}

interface Headword {
  sources?: Array<{ originalText?: string }>
}
interface ParsedEntry {
  text?: string
  headwords?: Headword[][]
}

/**
 * The word Yomitan's `/tokenize` found at the very start of `windowText`, or null.
 *
 * Its parser anchors at the characters it matched, but an inflected form's whole span (書き込み,
 * not 書) is in `headwords[*][*].sources[*].originalText`; the longest of those that starts with
 * the anchor and is literally in the text is the word.
 */
export function wordAtStart(chunks: unknown, windowText: string): string | null {
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const content = (chunk as { content?: unknown })?.content
    for (const group of Array.isArray(content) ? content : []) {
      const entry = (Array.isArray(group) ? group[0] : null) as ParsedEntry | null
      if (!entry?.text) continue
      // Anchors arrive in order: one that is not at the start means no word starts here.
      if (!windowText.startsWith(entry.text)) return null
      let widest = entry.text
      for (const headwords of entry.headwords ?? []) {
        for (const headword of Array.isArray(headwords) ? headwords : []) {
          for (const source of headword?.sources ?? []) {
            const text = source?.originalText
            if (text && text.length > widest.length && text.startsWith(entry.text) && windowText.startsWith(text))
              widest = text
          }
        }
      }
      return widest
    }
  }
  return null
}

export interface Scanner {
  /** The pointer is at `point` with Shift held. */
  scan(point: ScanPoint): void
  /** Look up the word at `point` once, now (a click). */
  lookUp(point: ScanPoint): void
  /** Shift was let go: nothing more is looked up. The pop-up and its word's selection stay. */
  stop(): void
  /** The pop-up closed: clear its word's selection, unless the reader selected something else. */
  clearSelection(): void
}

export function createScanner(options: ScannerOptions): Scanner {
  let active = false
  /** The current look is a one-off `lookUp`. */
  let once = false
  let latest: ScanPoint | null = null
  let lastTick = 0
  let tickTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let rerun = false
  let pending: { key: string; timer: ReturnType<typeof setTimeout> } | null = null
  let shown: string | null = null
  let selected: Range | null = null
  const cache = new Map<string, string>()

  const cancelPending = (): void => {
    if (pending) clearTimeout(pending.timer)
    pending = null
  }

  async function wordAt(windowText: string): Promise<string | null> {
    const cached = cache.get(windowText)
    if (cached !== undefined) return cached || null
    let word: string | null = null
    try {
      word = wordAtStart(await options.tokenize(windowText, windowText.length), windowText)
    } catch (error) {
      console.warn('[scan] tokenize failed', error)
      return null // not cached: the API may be back on the next try
    }
    if (cache.size > 2000) cache.clear()
    cache.set(windowText, word ?? '')
    return word
  }

  function select(range: Range): void {
    const selection = window.getSelection()
    if (!selection || !range.startContainer.isConnected) return
    selection.removeAllRanges()
    selection.addRange(range)
    selected = range.cloneRange()
  }

  async function look(): Promise<void> {
    const point = latest
    if (!active || !point) return
    const hit = caretFromPoint(point.x, point.y)
    if (!hit || !hit.node.parentElement?.closest(options.region)) return
    const block = hit.node.parentElement.closest(options.block)
    const windowText = readForward(hit.node, hit.offset, SCAN_WINDOW, block)
    if (!windowText.trim()) return
    const term = await wordAt(windowText)
    if (!active) return
    if (once && !term) {
      once = active = false
      return
    }
    if (!term) {
      // Off any word: whatever was about to open is not wanted. The pop-up already open stays.
      cancelPending()
      return
    }
    const range = forwardRange(hit.node, hit.offset, term.length, block)
    const box = range?.getBoundingClientRect()
    // screen − client is where this document's viewport sits on the desktop.
    const anchor =
      box && (box.width || box.height)
        ? {
            x: box.left + point.screenX - point.x,
            y: box.top + point.screenY - point.y,
            width: box.width,
            height: box.height
          }
        : null
    // The same word at the same place is the pop-up already showing; elsewhere it moves.
    const key = `${term}@${Math.round(anchor?.x ?? point.screenX)},${Math.round(anchor?.y ?? point.screenY)}`
    const sentence = options.sentenceOf(hit.node)
    if (once) {
      once = active = false
      cancelPending()
      shown = key
      if (range) select(range)
      options.show({ term, sentence, anchor, point, clicked: true })
      return
    }
    if (key === shown) {
      cancelPending()
      return
    }
    if (pending?.key === key) return
    cancelPending()
    const timer = setTimeout(() => {
      pending = null
      if (!active) return
      shown = key
      if (range) select(range)
      options.show({ term, sentence, anchor, point, clicked: false })
    }, DWELL_MS)
    pending = { key, timer }
  }

  async function tick(): Promise<void> {
    tickTimer = null
    if (inFlight) {
      // One lookup at a time: run once more with the latest point when it lands.
      rerun = true
      return
    }
    inFlight = true
    lastTick = performance.now()
    try {
      await look()
    } finally {
      inFlight = false
      if (rerun) {
        rerun = false
        if (active) void tick()
      }
    }
  }

  return {
    scan(point) {
      active = true
      latest = point
      const since = performance.now() - lastTick
      if (since >= THROTTLE_MS) void tick()
      else tickTimer ??= setTimeout(() => void tick(), THROTTLE_MS - since)
    },
    lookUp(point) {
      latest = point
      active = once = true
      void tick()
    },
    stop() {
      if (!active || once) return
      active = false
      shown = null
      rerun = false
      cancelPending()
      if (tickTimer) clearTimeout(tickTimer)
      tickTimer = null
    },
    clearSelection() {
      const selection = window.getSelection()
      const current = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null
      if (
        selected &&
        current &&
        current.startContainer === selected.startContainer &&
        current.startOffset === selected.startOffset &&
        current.endContainer === selected.endContainer &&
        current.endOffset === selected.endOffset
      )
        selection?.removeAllRanges()
      selected = null
      shown = null
    }
  }
}
