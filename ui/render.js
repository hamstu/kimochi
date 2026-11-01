/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Drawing recognised text over the captured source.
 *
 * A port of src/renderer/src/components/TextOverlay.tsx, including both of its
 * render modes and — more importantly — the interaction contract that makes
 * Yomitan work on top of it:
 *
 *  - every box carries the *next ten* annotations' text, in reading order, unseen
 *    but present in the DOM, so a lookup can run past the end of a box when OCR
 *    split a word (see `.ocr-lookahead` in overlay.html for how it stays scannable)
 *  - while a lookup's selection runs past the hovered box, that box widens to show
 *    the whole matched word and the boxes whose text it swallowed are hidden, so the
 *    reader sees 食べました once, where 食べ was, rather than two lit halves (see
 *    `selectionExtension` and `.ocr-word-current[data-ext]` in overlay.html)
 *  - entering a box dismisses any open popup with a synthetic Escape
 *  - clicking dispatches a synthetic shift+mousedown, which is what Yomitan's
 *    scanner treats as "look this up"; clicking the same box again dismisses
 *  - hovering pauses auto-scan, so the page cannot change out from under a lookup
 *
 * This is deliberately plain DOM rather than a framework: the overlay shares a
 * realm with Yomitan's content script, whose text scanner holds live Ranges over
 * these very text nodes. Re-rendering underneath it would break lookups.
 */

import { mapAnnotations, mapRect } from './geometry.js'
import { visibleAnnotations, groupTextAnnotations, getBoundingBox } from './annotations.js'
import { layoutParts, characterCells } from './text-layout.js'
import { hexToRgbTriplet, highlightStrength } from './settings.js'

const LOOKAHEAD = 10
const PROXIMITY_MAX_DISTANCE = 300
const GROUP_PADDING_X = 8
const GROUP_PADDING_Y = 6
const GROUP_LINE_HEIGHT = 1.3
/** Japanese glyphs are close to square; 0.85 leaves room without clipping. */
const CHAR_ASPECT_RATIO = 0.85
/** The card's own border: its runs are placed against the padding box inside it. */
/** The card's edge is an inset shadow (overlay-text.css), so its padding box is its whole box. */
const GROUP_BORDER = 0
/**
 * Grouped text is set in the platform's Japanese gothic, whose kana and kanji all advance one
 * em, so a run's cells are even and spacing alone can stretch it over the original.
 */
export const GROUP_FONT =
  "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Noto Sans CJK JP', 'Yu Gothic', 'Meiryo', sans-serif"

/**
 * The typeface Manga OCR's text is set in: Zen Kaku Gothic Antique, a gothic with the classic
 * kana of manga lettering, bundled (dist/ui/fonts/manga.css, from scripts/prepare.mjs) so it needs
 * no network. Light enough at 500 to read over the page; 700 for text big for its page, which in
 * manga is shouted and lettered bold. The platform gothic stands in until it has loaded.
 */
export const MANGA_FONT = `'Zen Kaku Gothic Antique', ${GROUP_FONT}`

/**
 * How each typeface is drawn: its family, its weight, and the heavier weight big text takes.
 * Light weights: the text is read off an opaque card (overlay-text.css), where a bold face only
 * looks heavy. The platform gothic at its regular (Hiragino W4, Yu Gothic Regular); the manga
 * face at its medium, which is its lighter bundled weight.
 */
const TYPEFACES = {
  default: { family: GROUP_FONT, weight: '400', bold: '700' },
  manga: { family: MANGA_FONT, weight: '500', bold: '700' }
}
const faceOf = (typeface) => TYPEFACES[typeface] ?? TYPEFACES.default

/**
 * Text at least this many times its page's typical size, and at least BOLD_SIZE px, is set in
 * its typeface's heavier weight: a heading or a shout, which a manga letters bold. Both bars are
 * high: ordinary dialogue stays light however a page sizes it.
 */
const BOLD_RATIO = 1.8
const BOLD_SIZE = 56

/** Each run's weight in its typeface (`run.weight`), heavier where it is big for its page. */
function weigh(layouts, typefaces) {
  const sizes = layouts
    .flatMap((runs) => runs.map((run) => run.fontSize))
    .sort((a, b) => a - b)
  // One run alone is its own typical size, so only the absolute bar applies to it.
  const typical = sizes.length > 1 ? sizes[(sizes.length - 1) >> 1] : 0
  return layouts.map((runs, index) => {
    const face = faceOf(typefaces[index])
    return runs.map((run) => {
      const big = run.fontSize >= BOLD_SIZE && run.fontSize >= BOLD_RATIO * typical
      return { ...run, weight: big ? face.bold : face.weight }
    })
  })
}

const measures = new Map()
/**
 * A typeface's measure: a run's natural advance in ems as drawn, with `.ink`, where its ink is
 * (see `inkOf` in text-layout.js), both read off a canvas set in the face at 100 px. Without a
 * canvas (tests) the advance is one em per full-width character and a little over half for the
 * rest, and the ink unknown.
 */
export function measureFor(typeface = 'default') {
  const known = measures.get(typeface)
  if (known) return known
  const face = faceOf(typeface)
  let context = null
  const canvas = () => {
    if (context === null && typeof document !== 'undefined') {
      context = document.createElement('canvas').getContext?.('2d') ?? false
      if (context) {
        context.font = `${face.weight} 100px ${face.family}`
        // As drawn: `.ocr-word` and `.ocr-run` turn kerning off (overlay.html).
        context.fontKerning = 'none'
      }
    }
    return context
  }
  const advances = new Map()
  const inks = new Map()
  const measure = (text) => {
    const cached = advances.get(text)
    if (cached !== undefined) return cached
    let ems = 0
    const drawn = canvas()
    if (drawn) ems = drawn.measureText(text).width / 100
    else
      for (const character of text) ems += /[\u0020-\u024f\uff61-\uff9f]/u.test(character) ? 0.56 : 1
    if (advances.size > 2000) advances.clear()
    advances.set(text, ems)
    return ems
  }
  measure.ink = (text) => {
    const cached = inks.get(text)
    if (cached !== undefined) return cached
    let ink = null
    const drawn = canvas()
    if (drawn) {
      const m = drawn.measureText(text)
      ink = {
        advance: m.width / 100,
        start: -m.actualBoundingBoxLeft / 100,
        end: m.actualBoundingBoxRight / 100,
        ascent: m.actualBoundingBoxAscent / 100,
        descent: m.actualBoundingBoxDescent / 100,
        fontAscent: m.fontBoundingBoxAscent / 100,
        fontDescent: m.fontBoundingBoxDescent / 100
      }
      const usable =
        Object.values(ink).every(Number.isFinite) &&
        ink.end > ink.start &&
        ink.ascent + ink.descent > 0 &&
        ink.fontAscent + ink.fontDescent > 0
      if (!usable) ink = null
    }
    if (inks.size > 2000) inks.clear()
    inks.set(text, ink)
    return ink
  }
  // Measured before the face loaded, these are the fallback's: forget them once it has.
  measure.forget = () => {
    advances.clear()
    inks.clear()
  }
  measures.set(typeface, measure)
  return measure
}

/** The overlay's own typeface's measure: see `measureFor`. */
export const measureEms = measureFor('default')
/** Where a run's ink is in the overlay's own typeface, or null: see `measureFor`. */
export const measureInk = measureEms.ink

/**
 * Whether the bundled typefaces `annotations` are set in have loaded for their characters; if not,
 * starts loading them and calls `done` when they have. The faces are split by character range and
 * load on demand, and a canvas measures with the fallback until they arrive, which would size and
 * space every run for the wrong glyphs.
 */
function typefacesReady(annotations, done) {
  if (typeof document === 'undefined' || !document.fonts?.check) return true
  const text = annotations
    .filter((a) => a.typeface === 'manga')
    .map((a) => a.description ?? '')
    .join('')
  if (!text) return true
  const face = faceOf('manga')
  const specs = [face.weight, face.bold].map((weight) => `${weight} 100px ${face.family}`)
  if (specs.every((spec) => document.fonts.check(spec, text))) return true
  Promise.all(specs.map((spec) => document.fonts.load(spec, text))).then(
    () => {
      measureFor('manga').forget()
      done()
    },
    () => {}
  )
  return false
}

/**
 * One fitted run as an element (`.ocr-run`), placed against an origin.
 *
 * Grouped runs are absolutely positioned in their card: the origin is its padding box's corner.
 * A word box's lines are zero-size inline blocks (overlay.html), so all of the box's text stays
 * one inline flow a lookup can run through from line to line; each is offset from where it flows,
 * which is the box's top-left for horizontal text, and its top-right, where a vertical-rl line
 * starts, for vertical text.
 */
function runElement(run, origin, vertical, inline) {
  const span = document.createElement('span')
  span.className = 'ocr-run'
  Object.assign(span.style, runStyle(run, origin, vertical, inline))
  span.append(document.createTextNode(run.text))
  return span
}

/**
 * Every word-mode box's runs, fitted together (text-layout.js), for boxes as `mapAnnotations`
 * gives them. `measure` is the overlay font's (tests pass recorded metrics).
 */
export function wordLayout(mapped, measure = measureEms) {
  return weigh(layoutParts(withTypefaces(mapped.map(partOf), mapped, measure), measure), mapped.map((box) => box.typeface))
}

/**
 * Parts measured in their own typefaces (`part.measure`), in the overlay; a caller's own measure
 * (tests' recorded metrics) measures everything as it is.
 */
function withTypefaces(parts, boxes, measure) {
  if (measure !== measureEms) return parts
  return parts.map((part, index) =>
    boxes[index].typeface ? { ...part, measure: measureFor(boxes[index].typeface) } : part
  )
}

/** What the layout (text-layout.js) needs of a mapped box: everything OCR said about its text. */
export function partOf(box) {
  return {
    text: box.text,
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    lines: box.lines ?? [],
    lineSegments: box.lineSegments,
    lineTexts: box.lineTexts,
    segments: box.segments,
    margin: box.inkMargin,
    block: box.granularity === 'block',
    vertical: box.orientation === 'vertical' || box.isVertical === true
  }
}

/** A fitted layout, rounded, so a render that changes nothing can be told from one that does. */
function runSignature(runs) {
  const round = (value) => Math.round(value * 100) / 100
  return runs.map((run) => [
    run.text,
    ...[run.rect.x, run.rect.y, run.rect.width, run.rect.height].map(round),
    ...[run.fontSize, run.spacing, run.lead, run.shift].map(round),
    run.weight
  ])
}

/** The inline style that places a fitted run: see `runElement`. */
function runStyle(run, origin, vertical, inline) {
  const left = vertical
    ? (inline ? run.rect.x + run.rect.width : run.rect.x) - origin.x + run.shift
    : run.rect.x - origin.x + run.lead
  return {
    left: `${left}px`,
    top: `${run.rect.y - origin.y + (vertical ? run.lead : run.shift)}px`,
    ...(inline ? {} : { width: `${run.rect.width}px`, height: `${run.rect.height}px` }),
    fontSize: `${run.fontSize}px`,
    ...(run.weight ? { fontWeight: run.weight } : {}),
    letterSpacing: `${run.spacing}px`,
    lineHeight: `${vertical ? run.rect.width : run.rect.height}px`
  }
}

/**
 * Reading order within one paragraph, the same order `logicalGroups` (ocr-result.ts) writes
 * a group's text in: vertical text in columns right to left, each read top to bottom;
 * horizontal text in lines top to bottom, each read left to right. Two boxes share a line
 * (or column) when their centres are within 0.7 of the thinner box's line height.
 */
function compareReadingOrder(vertical) {
  return (a, b) => {
    const ax = a.box.x + a.box.width / 2
    const bx = b.box.x + b.box.width / 2
    const ay = a.box.y + a.box.height / 2
    const by = b.box.y + b.box.height / 2
    const order = vertical
      ? Math.abs(ax - bx) < Math.min(a.box.width, b.box.width) * 0.7
        ? a.box.y - b.box.y
        : bx - ax
      : Math.abs(ay - by) < Math.min(a.box.height, b.box.height) * 0.7
        ? a.box.x - b.box.x
        : a.box.y - b.box.y
    return order || a.index - b.index
  }
}

/**
 * For each box, the index of the box that follows it in reading order within its paragraph,
 * or -1 for the last box of a paragraph.
 *
 * OCR order is not reading order. Cloud engines return chunks roughly in reading order,
 * but nothing guarantees it, and a column of vertical text read in the wrong order hands
 * Yomitan nonsense to match against. A paragraph is the box's `groupId` (every result
 * normalised by ocr-result.ts carries one); boxes without one are treated as one paragraph.
 */
export function readingSuccessors(boxes) {
  const paragraphs = new Map()
  boxes.forEach((box, index) => {
    const key = box.groupId || ''
    const members = paragraphs.get(key)
    if (members) members.push({ box, index })
    else paragraphs.set(key, [{ box, index }])
  })
  const next = boxes.map(() => -1)
  for (const members of paragraphs.values()) {
    const first = members[0].box
    members.sort(compareReadingOrder(first.orientation === 'vertical' || first.isVertical === true))
    for (let i = 0; i + 1 < members.length; i++) next[members[i].index] = members[i + 1].index
  }
  return next
}

/**
 * The text a lookup may run into after each box: the next `count` boxes of its paragraph in
 * reading order, joined with nothing. Japanese has no spaces between words and Yomitan ends
 * a match at whitespace, so any joiner would cut every split word back in two.
 */
export function lookaheadTexts(boxes, next = readingSuccessors(boxes), count = LOOKAHEAD) {
  return boxes.map((_, index) => {
    let text = ''
    for (let j = next[index], n = 0; j !== -1 && n < count; j = next[j], n++) text += boxes[j].text
    return text
  })
}

/**
 * How a selection that starts in one word-mode box and runs into its lookahead should show.
 *
 * `extension` is the matched text past the end of the box, drawn after the box's own text
 * so the reader sees the whole word in one place; `consumed` are the indices of the following
 * boxes whose entire text the selection covers, which are hidden while it stands (their
 * text is now on the first box). A box the selection ends inside is neither: its text past
 * the match still belongs where it was. Nothing happens when the selection does not start
 * with the box's text, or `startIndex` is not a box.
 *
 * @param {string} selectedText
 * @param {number} startIndex
 * @param {{text: string, next: number}[]} words — each box's text and reading-order successor
 * @returns {{extension: string, consumed: number[]}}
 */
export function selectionExtension(selectedText, startIndex, words) {
  const start = words[startIndex]
  if (!start || !selectedText || !selectedText.startsWith(start.text))
    return { extension: '', consumed: [] }
  let overflow = selectedText.slice(start.text.length)
  let extension = ''
  const consumed = []
  for (let j = start.next ?? -1; j !== -1 && overflow.length > 0; j = words[j]?.next ?? -1) {
    const text = words[j].text
    if (overflow.startsWith(text)) {
      consumed.push(j)
      extension += text
      overflow = overflow.slice(text.length)
    } else {
      if (text.startsWith(overflow)) extension += overflow
      break
    }
  }
  return { extension, consumed }
}

/**
 * How a box shows for the pointer: `lit`, the card with its text (hovered, or a selection's);
 * else `near`, 0–1, how much its resting highlight brightens as the pointer approaches, so the
 * reader can see what is hoverable without the overlay obscuring the source (overlay-text.css
 * reads both).
 */
function proximityStyle(mouse, centerX, centerY, hovering) {
  const distance = Math.hypot(mouse.x - centerX, mouse.y - centerY)
  const near = Math.max(0, 1 - distance / PROXIMITY_MAX_DISTANCE)
  return { near: Math.round(near * 100) / 100, lit: hovering }
}

/**
 * The hovered card's padding past the box, in px: a share of the text's size, so a caption's
 * card is snug and a headline's roomy, within sensible bounds. Nothing inside moves for it.
 */
function cardPadding(fontSize) {
  return Math.round(Math.max(5, Math.min(14, fontSize * 0.32)))
}

/** The fade a box leaves by, where the Web Animations API exists (not in the tests' DOM). */
const LEAVE_MS = 180

function dispatchEscape() {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    })
  )
}

/** What Yomitan's scanner reads as a lookup gesture. */
function dispatchLookup(element, clientX, clientY) {
  element.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      shiftKey: true
    })
  )
}

function shimmer(width, height, radius) {
  const bar = document.createElement('div')
  bar.className = 'skeleton'
  Object.assign(bar.style, {
    width: `${width}px`,
    height: `${height}px`,
    borderRadius: `${radius}px`
  })
  return bar
}

export class TextOverlayRenderer {
  /**
   * @param {HTMLElement} container
   * @param {{onLookupStart: () => void, onActivity: () => void}} hooks
   */
  constructor(container, hooks = {}) {
    this.container = container
    this.hooks = hooks
    this.mouse = { x: -1000, y: -1000 }
    this.words = []
    /** Grouped mode's regions, which light on hover as word boxes do: {element, index, box, centerX, centerY}. */
    this.regions = []
    this.lastLookupIndex = null
    /** Boxes a selection starts in: lit as if hovered. */
    this.selectionIndices = new Set()
    /** Boxes whose whole text the selection swallowed past the box it started in: hidden. */
    this.consumedIndices = new Set()
    /** The text drawn after one box's own to show the whole selected word, or null. */
    this.extension = null
    /** While the controller reads word by word, boxes stay dark: its outline is the only mark. */
    this.quiet = false
    this.mode = 'words'
    this.frame = null
    /** Boxes fading out, each with the timer that removes it; see `retire`. */
    this.leaving = new Map()

    this.onMouseMove = (event) => this.setPointer(event.clientX, event.clientY)
    this.onSelectionChange = () => this.updateSelectionHighlight()
    window.addEventListener('mousemove', this.onMouseMove)
    document.addEventListener('selectionchange', this.onSelectionChange)
  }

  /**
   * Where the pointer is, in this window's own coordinates.
   *
   * Fed from two places, and the second is the important one. The overlay is
   * click-through everywhere except over the words themselves, and the reader's own
   * application owns the pointer while they read — so a `mousemove` of its own only
   * arrives once the pointer is already on a word. The proximity effect is what tells
   * them a word is *there*, so it has to follow a pointer this window never sees, and
   * native sends it (see the cursor poll in `main.rs`).
   *
   * Cosmetic only: nothing here takes focus, and neither does arriving on a word.
   */
  setPointer(x, y) {
    if (this.mouse.x === x && this.mouse.y === y) return
    this.mouse = { x, y }
    this.scheduleProximityUpdate()
  }

  /**
   * Light the box under the pointer now rather than on the next frame. 10ten looks up as the
   * pointer event arrives and drops text it cannot see (`checkVisibility({checkOpacity: true})`
   * in 10ten-ja-content.js `isVisible`), and an unlit box's text is at opacity 0, so the event
   * that brings the pointer onto a box must find it lit. Yomitan waits before it scans, and
   * Hachidori does not check.
   */
  flushPointer() {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
    if (this.hoverables().length > 0) this.updateProximity()
  }

  /** What lights as the pointer nears and rests on it: word boxes, or grouped mode's regions. */
  hoverables() {
    return this.mode === 'groups' ? this.regions : this.words
  }

  /** Hold every box unlit and unmarked (true), or let hovering and selection show again. */
  setQuiet(quiet) {
    if (this.quiet === quiet) return
    this.quiet = quiet
    this.updateProximity()
  }

  /**
   * The look (Settings → OCR & Overlay → Overlay look): the highlight colour, `#rrggbb`, and
   * the cards' appearance, light, dark or blend. Set on the container, where overlay-text.css reads
   * them; everything drawn, or still to be drawn, follows.
   */
  setStyle({ color, theme, opacity }) {
    if (Number.isFinite(opacity)) {
      this.container.style.setProperty('--ocr-hl-strength', String(highlightStrength(opacity)))
    } else this.container.style.removeProperty('--ocr-hl-strength')
    const rgb = hexToRgbTriplet(color)
    if (rgb) this.container.style.setProperty('--ocr-hl-rgb', rgb)
    else this.container.style.removeProperty('--ocr-hl-rgb')
    if (theme === 'light' || theme === 'dark' || theme === 'blend') this.container.dataset.ocrTheme = theme
    else delete this.container.dataset.ocrTheme
  }

  /**
   * Where each character of a word-mode box is on the source, one cell per code unit of its text
   * (see `characterCells`), from the runs the box's text is drawn with. Null for anything but a
   * word-mode box drawn as one run: a block's lines are each their own text node, which the
   * controller reads (and outlines, from the drawn text) one at a time.
   */
  charRects(element) {
    const word = this.words.find((candidate) => candidate.element === element)
    if (!word?.runs || word.runs.length !== 1 || word.runs[0].text !== word.box.text) return null
    const { box } = word
    const vertical = box.orientation === 'vertical' || box.isVertical === true
    return characterCells(box.text, word.runs, vertical, box.typeface ? measureFor(box.typeface) : measureEms)
  }

  /** The pointer has gone somewhere this window cannot see; let the effect fade. */
  clearPointer() {
    this.setPointer(-100000, -100000)
  }

  destroy() {
    window.removeEventListener('mousemove', this.onMouseMove)
    document.removeEventListener('selectionchange', this.onSelectionChange)
    this.clear()
  }

  /**
   * Take everything off screen: at once, so text that belongs to a window the reader just
   * left goes with its click targets; or, `fade`, each box fading out where it was (a scan
   * that found nothing).
   */
  clear({ fade = false } = {}) {
    this.renderSignature = null
    this.placementSignature = null
    if (fade) for (const element of [...this.container.children]) this.retire(element)
    else {
      for (const timer of this.leaving.values()) clearTimeout(timer)
      this.leaving.clear()
      if (this.container.children.length) this.container.replaceChildren()
    }
    this.words = []
    this.regions = []
    this.lastLookupIndex = null
    this.selectionIndices = new Set()
    this.consumedIndices = new Set()
    this.extension = null
  }

  /**
   * Fade a box out and remove it. It stops being a hit target at once (`hitRects`,
   * `[data-leaving]`), stays a child until it has faded, and is revived if the next render wants
   * it back (`render`): a scan that flickers a word away and back does not blink it. Without
   * the Web Animations API (the tests' DOM) it goes at once.
   */
  retire(element) {
    if (this.leaving.has(element)) return
    if (typeof element.animate !== 'function') {
      element.remove()
      return
    }
    element.dataset.leaving = ''
    element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LEAVE_MS, easing: 'ease-out', fill: 'forwards' })
    this.leaving.set(
      element,
      setTimeout(() => {
        this.leaving.delete(element)
        element.remove()
      }, LEAVE_MS + 20)
    )
  }

  /** A box on its way out that the next render wants after all: back to stay. */
  revive(element) {
    const timer = this.leaving.get(element)
    if (timer === undefined) return
    clearTimeout(timer)
    this.leaving.delete(element)
    delete element.dataset.leaving
    for (const animation of element.getAnimations?.() ?? []) animation.cancel()
  }

  /**
   * Where the first rendered box currently sits, in overlay-local points.
   *
   * Diagnostic only: the overlay is capture-protected, so a screenshot cannot
   * show whether text moved with its window. This is the checkable number.
   */
  firstBox() {
    const first = this.words[0]?.box ?? null
    if (first) return { x: first.x, y: first.y, width: first.width, height: first.height }
    const element = this.container.firstElementChild
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  /**
   * The desktop rectangles this renderer wants the mouse for.
   *
   * None of them ask for focus. A word is something to point at, not something to
   * type into, and the keyboard the overlay would be taking belongs to the game the
   * reader is playing. Looking a word up needs no focus at all: the modifier arrives
   * with the pointer from native (see the cursor poll in `main.rs`).
   */
  hitRects(origin) {
    if (!origin) return []
    return [...this.container.children]
      .filter((element) => {
        if (this.leaving.has(element)) return false
        const style = getComputedStyle(element)
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
      })
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        x: origin.x + rect.x,
        y: origin.y + rect.y,
        width: rect.width,
        height: rect.height,
        focus: false
      }))
  }

  /**
   * Replace everything on screen with this scan's text.
   *
   * @param {{annotations: unknown[], info: object, origin: object,
   *          grouping: object, opacity: number, scanning: boolean}} view
   */
  render(view) {
    const { annotations, info, origin, grouping, opacity, bounds } = view
    if (!annotations?.length || !info || !origin) {
      this.clear({ fade: true })
      return
    }
    const placement = JSON.stringify([
      info.full_width,
      info.full_height,
      info.crop_pixels,
      bounds ?? info.source_bounds,
      origin,
      grouping,
      opacity
    ])
    const samePlacement = placement === this.placementSignature
    this.placementSignature = placement
    const signature = JSON.stringify([
      annotations,
      info.full_width,
      info.full_height,
      info.crop_pixels,
      bounds ?? info.source_bounds,
      origin,
      grouping,
      opacity
    ])
    if (signature === this.renderSignature)
      return { created: 0, retained: this.container.children.length - this.leaving.size, removed: 0 }
    this.renderSignature = signature
    const filtered = visibleAnnotations(annotations, grouping)
    if (!filtered.length) {
      this.clear({ fade: true })
      return
    }
    // Laid out now in the fallback if a bundled face is still loading, and again once it has.
    typefacesReady(filtered, () => {
      if (this.renderSignature !== signature) return
      this.renderSignature = null
      this.render(view)
    })

    // Existing recognized words remain usable while another request runs.
    // Loading belongs on the controller, not in place of known text.
    const oldWords = new Map(this.words.map((word) => [word.element, word]))
    const oldChildren = [...this.container.children]
    const selected = new Set(
      this.words.filter((word) => this.selectionIndices.has(word.index)).map((word) => word.element)
    )
    const consumed = new Set(
      this.words.filter((word) => this.consumedIndices.has(word.index)).map((word) => word.element)
    )
    const extended = this.words.find((word) => word.index === this.extension?.index)?.element ?? null
    const lookup = oldChildren.find((element) => element.ocrIndex === this.lastLookupIndex)
    const oldRegions = new Map(this.regions.map((region) => [region.element, region]))
    this.words = []
    this.regions = []
    this.mode = grouping.enabled ? 'groups' : 'words'
    const fragment = grouping.enabled
      ? this.renderGroups(filtered, info, origin, grouping, opacity, false, bounds)
      : this.renderWords(filtered, info, origin, false, bounds)
    const available = new Map(oldChildren.map((element) => [element.renderKey, element]))
    const desired = [...fragment.children].map((fresh) => {
      let old = available.get(fresh.renderKey)
      if (!old && samePlacement) {
        // OCR often nudges the same word by a pixel. Hold its original placement
        // within two points; compare against that anchor, never cumulative drift.
        old = [...available.values()].find(
          (candidate) =>
            candidate.renderText === fresh.renderText &&
            candidate.className === fresh.className &&
            candidate.renderBox &&
            fresh.renderBox &&
            ['x', 'y', 'width', 'height'].every(
              (key) => Math.abs(candidate.renderBox[key] - fresh.renderBox[key]) <= 2
            )
        )
      }
      if (!old) return fresh
      available.delete(old.renderKey)
      this.revive(old)
      old.ocrIndex = fresh.ocrIndex
      const ahead = old.querySelector('.ocr-lookahead')
      const nextAhead = fresh.querySelector('.ocr-lookahead')
      if (ahead && nextAhead && ahead.textContent !== nextAhead.textContent)
        ahead.textContent = nextAhead.textContent
      const region = this.regions.find((region) => region.element === fresh)
      if (region && oldRegions.has(old)) region.element = old
      const word = this.words.find((word) => word.element === fresh)
      const previous = oldWords.get(old)
      if (word && previous)
        Object.assign(word, {
          element: old,
          text: previous.text,
          current: previous.current,
          box: previous.box,
          runs: previous.runs,
          centerX: previous.centerX,
          centerY: previous.centerY
        })
      return old
    })
    const keep = new Set(desired)
    for (const element of oldChildren) if (!keep.has(element)) this.retire(element)
    desired.forEach((element, index) => {
      if (this.container.children[index] !== element)
        this.container.insertBefore(element, this.container.children[index] ?? null)
    })
    this.selectionIndices = new Set(
      this.words.filter((word) => selected.has(word.element)).map((word) => word.index)
    )
    // The extension and the hidden boxes belong to one selection, from the box it started
    // in; if that box did not survive, nothing stays hidden on its account.
    const extendedWord = extended && this.words.find((word) => word.element === extended)
    this.extension = extendedWord ? { index: extendedWord.index, text: this.extension.text } : null
    this.consumedIndices = new Set(
      extendedWord
        ? this.words.filter((word) => consumed.has(word.element)).map((word) => word.index)
        : []
    )
    this.applySelectionMarks()
    this.lastLookupIndex = lookup && keep.has(lookup) ? lookup.ocrIndex : null
    this.scheduleProximityUpdate()
    return {
      created: desired.filter((element) => !oldChildren.includes(element)).length,
      retained: desired.filter((element) => oldChildren.includes(element)).length,
      removed: oldChildren.filter((element) => !keep.has(element)).length
    }
  }

  // --- per-word mode --------------------------------------------------------

  renderWords(annotations, info, origin, scanning, bounds) {
    const mapped = mapAnnotations(info, annotations, origin, bounds)
    const successors = readingSuccessors(mapped)
    const ahead = lookaheadTexts(mapped, successors)
    const fragment = document.createDocumentFragment()
    // Every box fitted over the text it was read from, rows set at one size (text-layout.js).
    const layouts = scanning ? [] : wordLayout(mapped)

    mapped.forEach((box, index) => {
      const element = document.createElement('div')
      element.dataset.ocrWordBox = 'true'
      Object.assign(element.style, {
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.width}px`,
        height: `${box.height}px`
      })
      // The box OCR saw, for the floor a box extended past its text keeps (overlay.html).
      element.style.setProperty('--ocr-width', `${box.width}px`)
      element.style.setProperty('--ocr-height', `${box.height}px`)

      if (scanning) {
        element.className = 'ocr-skeleton'
        element.append(shimmer(box.width, Math.max(box.height * 0.7, 8), box.height * 0.35))
        fragment.append(element)
        return
      }

      const vertical = box.orientation === 'vertical' || box.isVertical === true
      const block = box.granularity === 'block' || box.text.includes('\n')
      element.className = `ocr-word${vertical ? ' ocr-vertical' : ''}${block ? ' ocr-block' : ''}${
        box.typeface === 'manga' ? ' ocr-manga' : ''
      }`
      // What the box sits on (surface.rs), which a Blend card is filled with (overlay-text.css).
      if (box.surface) {
        element.dataset.surface = box.surface.ink
        element.style.setProperty('--ocr-surface-top', box.surface.top)
        element.style.setProperty('--ocr-surface-bottom', box.surface.bottom)
      }
      const runs = layouts[index]
      // The hovered card reaches this far past the box (overlay-text.css); the text stays put.
      element.style.setProperty(
        '--ocr-pad',
        `${cardPadding(Math.max(...runs.map((run) => run.fontSize), 0))}px`
      )
      // A word or a single line is drawn as the box's own text; a block's lines each as a run.
      const single = runs.length === 1 && runs[0].text === box.text
      // Where the box's text starts to flow: its top-left, or top-right for a vertical-rl line.
      const flow = { x: vertical ? box.x + box.width : box.x, y: box.y }
      Object.assign(
        element.style,
        single
          ? {
              fontSize: `${runs[0].fontSize}px`,
              ...(runs[0].weight ? { fontWeight: runs[0].weight } : {}),
              lineHeight: `${vertical ? runs[0].rect.width : runs[0].rect.height}px`
            }
          : { fontSize: '0px', lineHeight: '0px' }
      )
      // The visible word, then the following words: present in the DOM for a lookup
      // to run into, and never seen. Cloud OCR splits words (食べ|ました), and a lookup
      // that stops at the end of this box can only ever find the first half.
      //
      // Two constraints pull against each other, and `.ocr-lookahead` in overlay.html
      // satisfies both (the details, and why the obvious alternatives fail, are there):
      //  - Yomitan's `DOMTextScanner` only enters an element its computed style calls
      //    visible: not `opacity: 0`, not `font-size: 0`, not `visibility: hidden`, not
      //    transparent unless selectable; and it ends a scan at an absolutely positioned
      //    or block-level element. So the text has to be "visible" inline content.
      //  - Yomitan positions the popup from `Range.getClientRects()` of the whole match,
      //    so text the reader is not pointing at must contribute no rectangle with area,
      //    or the popup follows the following words instead of the hovered one.
      const text = document.createElement('span')
      text.className = 'ocr-word-text'
      const current = document.createElement('span')
      current.className = 'ocr-word-current'
      // Held still while hovered: the text stays over the source it was read from.
      current.style.textAlign = 'left'
      if (single) {
        Object.assign(current.style, runStyle(runs[0], flow, vertical, true), {
          width: `${runs[0].rect.width}px`,
          height: `${runs[0].rect.height}px`
        })
        current.textContent = box.text
      } else {
        for (const run of runs) current.append(runElement(run, flow, vertical, true))
      }
      const lookahead = document.createElement('span')
      lookahead.className = 'ocr-lookahead'
      lookahead.textContent = ahead[index]
      text.append(current, lookahead)
      element.append(text)

      element.renderKey = JSON.stringify([
        this.mode,
        box.text,
        box.x,
        box.y,
        box.width,
        box.height,
        box.orientation,
        box.groupId,
        runSignature(runs)
      ])
      element.renderText = box.text
      element.renderBox = { x: box.x, y: box.y, width: box.width, height: box.height }
      this.attachInteraction(element, index)
      this.words.push({
        element,
        text,
        current,
        // How the box's text is laid over the source, for placing its characters (`charRects`).
        runs,
        index,
        // The word after this one in reading order, which is where its lookahead begins.
        next: successors[index],
        centerX: box.x + box.width / 2,
        centerY: box.y + box.height / 2,
        box
      })
      fragment.append(element)
    })

    return fragment
  }

  // --- grouped mode ---------------------------------------------------------

  renderGroups(annotations, info, origin, grouping, opacity, scanning, bounds) {
    const groups = groupTextAnnotations(annotations, grouping.proximityThreshold ?? 100)
    const fragment = document.createDocumentFragment()
    // Each line or word goes where OCR found it, fitted to it, every row at one size, the
    // same way word mode lays its boxes; see text-layout.js.
    const partsOf = groups.map((group) =>
      mapAnnotations(info, group.annotations, origin, bounds).map((box) => ({
        ...partOf(box),
        vertical: group.orientation === 'vertical'
      }))
    )
    const boxes = partsOf.flat()
    const typefaces = groups.flatMap((group, index) =>
      partsOf[index].map(() => group.annotations[0]?.typeface)
    )
    const fitted = scanning
      ? []
      : weigh(
          layoutParts(
            withTypefaces(boxes, typefaces.map((typeface) => ({ typeface })), measureEms),
            measureEms
          ),
          typefaces
        )
    let nextPart = 0
    const runsOf = partsOf.map((parts) => parts.flatMap(() => fitted[nextPart++] ?? []))

    groups.forEach((group, index) => {
      const { boundingBox, text } = group
      const rect = mapRect(
        info,
        origin,
        {
          x: boundingBox.minX,
          y: boundingBox.minY,
          width: boundingBox.width,
          height: boundingBox.height
        },
        bounds
      )

      const vertical = group.orientation === 'vertical'
      const lines = text.split('\n')
      const longest = Math.max(...lines.map((line) => line.length))
      const semanticBlock = group.annotations.some(a => a.granularity === 'block')
      const fontSize = Math.max(
        1,
        Math.min(
          semanticBlock && lines.length === 1
            ? Math.sqrt(rect.width * rect.height / Math.max(1, [...text].length) / GROUP_LINE_HEIGHT)
            : Math.min(
                (vertical ? rect.width : rect.height) / (lines.length * GROUP_LINE_HEIGHT),
                (vertical ? rect.height : rect.width) / (longest * CHAR_ASPECT_RATIO)
              ),
          48
        )
      )

      const element = document.createElement('div')
      element.className = `ocr-group${vertical ? ' ocr-vertical' : ''}${
        group.annotations[0]?.typeface === 'manga' ? ' ocr-manga' : ''
      }`
      element.dataset.ocrWordBox = 'true'
      Object.assign(element.style, {
        left: `${rect.x - GROUP_PADDING_X}px`,
        top: `${rect.y - GROUP_PADDING_Y}px`,
        width: `${rect.width + GROUP_PADDING_X * 2}px`,
        height: `${rect.height + GROUP_PADDING_Y * 2}px`,
        fontSize: `${fontSize}px`,
        lineHeight: String(GROUP_LINE_HEIGHT)
      })

      // What the cluster sits on, for Blend: its boxes' readings combined (`groupSurface`).
      const surface = groupSurface(group.annotations)
      if (surface) {
        element.dataset.surface = surface.ink
        element.style.setProperty('--ocr-surface-top', surface.top)
        element.style.setProperty('--ocr-surface-bottom', surface.bottom)
      }

      if (scanning) {
        element.classList.add('scanning')
        const stack = document.createElement('div')
        stack.className = 'skeleton-stack'
        stack.style.gap = `${fontSize * 0.3}px`
        for (const line of lines) {
          stack.append(
            shimmer(
              Math.min(line.length * fontSize * CHAR_ASPECT_RATIO, rect.width),
              fontSize,
              fontSize * 0.5
            )
          )
        }
        element.append(stack)
        fragment.append(element)
        return
      }

      const runs = runsOf[index]
      const body = document.createElement('span')
      body.className = 'ocr-runs'
      // The card's padding box, which its text is laid in. The runs are inline, one flow from
      // the first to the last, as a word box's lines are: an absolutely positioned run ends
      // Yomitan's scan (two newlines), so each line, or piece of a line cut at a gap, would be
      // a sentence of its own and no word could run on past a line's end. Each run is offset
      // from where the flow starts: the box's top-left, or top-right for vertical-rl.
      const corner = {
        x: rect.x - GROUP_PADDING_X + GROUP_BORDER,
        y: rect.y - GROUP_PADDING_Y + GROUP_BORDER
      }
      const inner = {
        width: rect.width + GROUP_PADDING_X * 2 - GROUP_BORDER * 2,
        height: rect.height + GROUP_PADDING_Y * 2 - GROUP_BORDER * 2
      }
      Object.assign(body.style, { width: `${inner.width}px`, height: `${inner.height}px` })
      const flow = { x: vertical ? corner.x + inner.width : corner.x, y: corner.y }
      for (const run of runs) body.append(runElement(run, flow, vertical, true))
      const lookahead = document.createElement('span')
      lookahead.className = 'ocr-lookahead'
      lookahead.textContent = '' // Semantic groups must not extend a lookup into another bubble.
      body.append(lookahead)
      element.append(body)

      element.renderKey = JSON.stringify([this.mode, text, rect, runSignature(runs), opacity, group.orientation])
      element.renderText = text
      element.renderBox = rect
      this.attachInteraction(element, index)
      // A shared box over the cluster: highlighted at rest and lit on hover, as a word box is.
      const region = {
        x: rect.x - GROUP_PADDING_X,
        y: rect.y - GROUP_PADDING_Y,
        width: rect.width + GROUP_PADDING_X * 2,
        height: rect.height + GROUP_PADDING_Y * 2
      }
      this.regions.push({
        element,
        index,
        box: region,
        centerX: region.x + region.width / 2,
        centerY: region.y + region.height / 2
      })
      fragment.append(element)
    })

    return fragment
  }

  // --- interaction ----------------------------------------------------------

  attachInteraction(element, index) {
    element.ocrIndex = index
    element.addEventListener('mouseenter', () => {
      // Close whatever is open before offering a new lookup, and hold the
      // scanner still while the pointer is over text.
      dispatchEscape()
      this.hooks.onActivity?.()
    })
    element.addEventListener('mousemove', () => this.hooks.onActivity?.())
    element.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.hooks.onActivity?.()
      if (this.lastLookupIndex === element.ocrIndex) {
        dispatchEscape()
        this.lastLookupIndex = null
        return
      }
      this.hooks.onLookupStart?.()
      dispatchLookup(event.currentTarget, event.clientX, event.clientY)
      this.lastLookupIndex = element.ocrIndex
    })
  }

  scheduleProximityUpdate() {
    if (this.hoverables().length === 0 || this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.updateProximity()
    })
  }

  updateProximity() {
    for (const word of this.hoverables()) {
      const { box } = word
      const consumed = this.consumedIndices.has(word.index)
      const hovering =
        !this.quiet &&
        !consumed &&
        (this.selectionIndices.has(word.index) ||
          (this.mouse.x >= box.x &&
            this.mouse.x <= box.x + box.width &&
            this.mouse.y >= box.y &&
            this.mouse.y <= box.y + box.height))
      const far = { x: -100000, y: -100000 }
      const style = proximityStyle(this.quiet ? far : this.mouse, word.centerX, word.centerY, hovering)
      // Lit, the box turns into its card and shows its text (`[data-lit]`, overlay-text.css), and
      // moves and resizes nothing: the text stays exactly over the source it was read from (an
      // extended box only grows past its end, over the boxes it hides). At rest its highlight
      // brightens with the pointer's approach. Attributes and a custom property, never a class:
      // `render` matches a nudged box on its class name.
      if (style.lit) word.element.dataset.lit = ''
      else delete word.element.dataset.lit
      word.element.style.setProperty('--ocr-near', String(style.near))
    }
  }

  /**
   * Mark the boxes for the selection as it stands: the extension on the box it starts
   * in, hidden on the boxes it swallowed. Attributes only — the class names take part
   * in `render`'s matching of nudged boxes, and the text nodes hold Yomitan's Range.
   */
  applySelectionMarks() {
    for (const word of this.words) {
      const extension = this.extension?.index === word.index ? this.extension.text : ''
      if (extension) {
        word.current.dataset.ext = extension
        word.element.dataset.extended = ''
      } else {
        delete word.current.dataset.ext
        delete word.element.dataset.extended
      }
      if (this.consumedIndices.has(word.index)) word.element.dataset.consumed = ''
      else delete word.element.dataset.consumed
    }
  }

  /**
   * Show a selection that ran past its box as one word.
   *
   * A lookup from the first half of a split word selects that box's text and the
   * matched part of its lookahead, which is invisible by default. The box the
   * selection starts in is lit and shows the whole word (`selectionExtension`), and
   * the boxes whose text that covers are hidden under it, so the reader sees the word
   * once, where it begins, until the selection clears.
   */
  updateSelectionHighlight() {
    if (this.mode !== 'words' || this.words.length === 0) return
    const selection = window.getSelection()
    const selected = selection?.toString().trim() ?? ''
    const next = new Set()
    const consumed = new Set()
    let extension = null

    if (selected) {
      const anchor = selection?.anchorNode
      const start =
        anchor?.nodeType === Node.ELEMENT_NODE ? anchor : (anchor?.parentElement ?? null)
      const host = start?.closest?.('[data-ocr-word-box]') ?? null
      const index = this.words.findIndex((word) => word.element === host)
      if (index !== -1) {
        const chain = this.words.map((word) => ({ text: word.box.text, next: word.next ?? -1 }))
        const result = selectionExtension(selected, index, chain)
        if (selected.startsWith(chain[index].text)) {
          next.add(this.words[index].index)
          for (const j of result.consumed) consumed.add(this.words[j].index)
          if (result.extension) extension = { index: this.words[index].index, text: result.extension }
        }
      }
    }

    const same = (a, b) => a.size === b.size && [...a].every((i) => b.has(i))
    if (
      same(next, this.selectionIndices) &&
      same(consumed, this.consumedIndices) &&
      extension?.index === this.extension?.index &&
      extension?.text === this.extension?.text
    )
      return
    this.selectionIndices = next
    this.consumedIndices = consumed
    this.extension = extension
    this.applySelectionMarks()
    this.updateProximity()
  }
}

/**
 * What a grouped region sits on, from what its boxes do (surface.rs reads each box's own): the
 * top box's colour above, the bottom box's below, and the text most of them call for (light on
 * a tie). Null when none of them has a reading.
 */
function groupSurface(annotations) {
  const read = annotations.filter((a) => a.surface)
  if (!read.length) return null
  const y = (a) => getBoundingBox(a)
  const top = read.reduce((best, a) => (y(a).minY < y(best).minY ? a : best))
  const bottom = read.reduce((best, a) => (y(a).maxY > y(best).maxY ? a : best))
  const dark = read.filter((a) => a.surface.ink === 'dark').length
  return {
    top: top.surface.top,
    bottom: bottom.surface.bottom,
    ink: dark > read.length - dark ? 'dark' : 'light'
  }
}

export { proximityStyle, dispatchEscape, dispatchLookup, getBoundingBox, groupSurface }
