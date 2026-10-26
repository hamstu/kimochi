/**
 * DEV-ONLY: the overlay stage's pretend game, and the OCR result a scan of it would give.
 *
 * The game is real DOM text (a visual novel's dialogue box, or a manga page of vertical speech
 * bubbles), so its "OCR" is exact: each line or column becomes one annotation at the box its glyphs
 * cover, and each furigana reading a small one of its own above its kanji, as an engine reports
 * them. The overlay drawn from those annotations then sits on the game's own text.
 */
import { parseRuby, type StageScript } from './script'

export type GameKind = 'dialogue' | 'manga'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The shape the overlay's renderer reads (ui/geometry.ts `Annotation`). */
export interface StageAnnotation {
  description: string
  boundingPoly: { vertices: { x: number; y: number }[] }
  orientation?: 'horizontal' | 'vertical'
  isVertical?: boolean
  typeface?: string
}

export interface GameOptions {
  kind: GameKind
  script: StageScript
  /** Draw the readings over the kanji (and so report them, as OCR does). */
  furigana: boolean
  /** A window on a desktop rather than the whole screen (a Mac game, not the Deck). */
  windowed: boolean
  /**
   * Report each word as its own box, as some engines do (a particle a box), instead of each
   * line: the case Read along's full screen has to put back together as the Log does.
   */
  fragments?: boolean
}

export interface Game {
  /** The game's window, in page coordinates: the capture's source bounds. */
  area: Rect
  annotations: StageAnnotation[]
}

const element = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A line of text with its readings as `<ruby>`, so the base glyphs stay one run of text. */
function textLine(line: string, className: string, furigana: boolean): HTMLElement {
  const node = element('div', className)
  for (const run of parseRuby(line)) {
    if (run.ruby && furigana) {
      const ruby = document.createElement('ruby')
      ruby.append(run.text, element('rt', '', run.ruby))
      node.append(ruby)
    } else node.append(run.text)
  }
  return node
}

function union(rects: DOMRect[]): Rect | null {
  const real = rects.filter((r) => r.width > 0 && r.height > 0)
  if (!real.length) return null
  const x = Math.min(...real.map((r) => r.left))
  const y = Math.min(...real.map((r) => r.top))
  return {
    x,
    y,
    width: Math.max(...real.map((r) => r.right)) - x,
    height: Math.max(...real.map((r) => r.bottom)) - y
  }
}

function annotation(text: string, rect: Rect, area: Rect, vertical: boolean): StageAnnotation {
  const x = Math.round(rect.x - area.x)
  const y = Math.round(rect.y - area.y)
  const right = Math.round(rect.x + rect.width - area.x)
  const bottom = Math.round(rect.y + rect.height - area.y)
  return {
    description: text,
    boundingPoly: {
      vertices: [
        { x, y },
        { x: right, y },
        { x: right, y: bottom },
        { x, y: bottom }
      ]
    },
    ...(vertical ? { orientation: 'vertical' as const, isVertical: true } : {})
  }
}

/** Read a drawn line back the way OCR would: its base text and box, and each reading's. */
function scanLine(node: HTMLElement, area: Rect, vertical: boolean, fragments = false): StageAnnotation[] {
  const base: Text[] = []
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!(text.parentElement?.closest('rt'))) base.push(text as Text)
  }
  const rects = base.flatMap((text) => {
    const range = document.createRange()
    range.selectNodeContents(text)
    return [...range.getClientRects()]
  })
  const box = union(rects)
  const found: StageAnnotation[] = []
  if (fragments) {
    // A box per word, as an engine that boxes words (or particles) on their own reports them.
    const words = new Intl.Segmenter('ja', { granularity: 'word' })
    for (const text of base) {
      for (const { segment, index } of words.segment(text.data)) {
        const range = document.createRange()
        range.setStart(text, index)
        range.setEnd(text, index + segment.length)
        const rect = union([...range.getClientRects()])
        if (rect && segment.trim()) found.push(annotation(segment, rect, area, vertical))
      }
    }
  } else if (box) found.push(annotation(base.map((t) => t.data).join(''), box, area, vertical))
  // A line's readings are one more line of small text to OCR, as engines report them.
  const readings = [...node.querySelectorAll('rt')]
  const rubyBox = union(
    readings.flatMap((rt) => {
      const range = document.createRange()
      range.selectNodeContents(rt)
      return [...range.getClientRects()]
    })
  )
  if (rubyBox) found.push(annotation(readings.map((rt) => rt.textContent).join(' '), rubyBox, area, vertical))
  return found
}

/** Draw the game into `host` and scan it. */
export function drawGame(host: HTMLElement, options: GameOptions): Game {
  host.replaceChildren()
  host.className = `game${options.windowed ? ' game-windowed' : ''}`
  host.dataset.kind = options.kind
  const screen = element('div', 'game-screen')
  if (options.windowed) {
    const bar = element('div', 'game-titlebar')
    bar.append(element('span', 'game-lights'), element('span', 'game-title', options.kind === 'manga' ? 'Manga reader' : 'Summer Pockets'))
    host.append(bar)
  }
  host.append(screen)

  const lines: { node: HTMLElement; vertical: boolean }[] = []
  if (options.kind === 'dialogue') {
    screen.append(element('div', 'game-sky'), element('div', 'game-sun'), element('div', 'game-sea'), element('div', 'game-cloud game-cloud-a'), element('div', 'game-cloud game-cloud-b'))
    const box = element('div', 'game-dialogue')
    box.append(element('div', 'game-speaker', options.script.speaker))
    for (const line of options.script.lines) {
      const node = textLine(line, 'game-line', options.furigana)
      box.append(node)
      lines.push({ node, vertical: false })
    }
    box.append(element('div', 'game-next', '▼'))
    screen.append(box)
  } else {
    const page = element('div', 'game-page')
    options.script.bubbles.forEach((columns, index) => {
      const panel = element('div', `game-panel game-panel-${index}`)
      const bubble = element('div', 'game-bubble')
      for (const column of columns) {
        const node = textLine(column, 'game-column', options.furigana)
        bubble.append(node)
        lines.push({ node, vertical: true })
      }
      panel.append(bubble)
      page.append(panel)
    })
    screen.append(page)
  }

  const r = screen.getBoundingClientRect()
  const area = { x: r.left, y: r.top, width: r.width, height: r.height }
  const scanned = lines.flatMap(({ node, vertical }) => scanLine(node, area, vertical, options.fragments))
  // The first annotation is the whole text, as Google Vision-style results lead with
  // (`wordAnnotations` drops it).
  const whole = annotation(scanned.map((a) => a.description).join('\n'), area, area, false)
  return { area, annotations: [whole, ...scanned] }
}

/** A stand-in screenshot of the game for the region editor's picture: its colours, nothing more. */
export function gamePicture(kind: GameKind): string {
  const svg =
    kind === 'manga'
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10"><rect width="16" height="10" fill="#f4f1ea"/><rect x="0.5" y="0.5" width="7.3" height="9" fill="#fff" stroke="#111" stroke-width="0.12"/><rect x="8.2" y="0.5" width="7.3" height="9" fill="#fff" stroke="#111" stroke-width="0.12"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10"><defs><linearGradient id="s" x2="0" y2="1"><stop offset="0" stop-color="#5aa6e8"/><stop offset="1" stop-color="#f6d9b0"/></linearGradient></defs><rect width="16" height="10" fill="url(#s)"/><rect y="6" width="16" height="4" fill="#2f7fb5"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
