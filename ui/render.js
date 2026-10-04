/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Drawing recognised text over the captured source.
 *
 * A port of src/renderer/src/components/TextOverlay.tsx, including both of its
 * render modes and — more importantly — the interaction contract that makes
 * Yomitan work on top of it:
 *
 *  - every box carries the *next ten* annotations' text, off-screen but present
 *    in the DOM, so a lookup can run past the end of a box when OCR split a word
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
import { layoutGroup, characterCells } from './text-layout.js'

const LOOKAHEAD = 10
const PROXIMITY_MAX_DISTANCE = 300
const GROUP_PADDING_X = 8
const GROUP_PADDING_Y = 6
const GROUP_LINE_HEIGHT = 1.3
/** Japanese glyphs are close to square; 0.85 leaves room without clipping. */
const CHAR_ASPECT_RATIO = 0.85
/** The card's own border: its runs are placed against the padding box inside it. */
const GROUP_BORDER = 1
/**
 * Grouped text is set in the platform's Japanese gothic, whose kana and kanji all advance one
 * em, so a run's cells are even and spacing alone can stretch it over the original.
 */
export const GROUP_FONT =
  "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Noto Sans CJK JP', 'Yu Gothic', 'Meiryo', sans-serif"

let measurer = null
const advances = new Map()
/**
 * A run's natural advance in ems, in the font it is drawn in. Without a canvas (tests) it falls
 * back to one em per full-width character and a little over half for the rest.
 */
export function measureEms(text) {
  const cached = advances.get(text)
  if (cached !== undefined) return cached
  let ems = 0
  if (measurer === null && typeof document !== 'undefined') {
    measurer = document.createElement('canvas').getContext?.('2d') ?? false
    if (measurer) measurer.font = `bold 100px ${GROUP_FONT}`
  }
  if (measurer) ems = measurer.measureText(text).width / 100
  else
    for (const character of text) ems += /[\u0020-\u024f\uff61-\uff9f]/u.test(character) ? 0.56 : 1
  if (advances.size > 2000) advances.clear()
  advances.set(text, ems)
  return ems
}

/** Shrink to fit the box, then use letter spacing for the remainder. */
function calculateFontSize(text, width, height, vertical = false) {
  if (vertical) [width, height] = [height, width]
  let fontSize = height * 0.7
  const charWidth = fontSize * 0.6
  if (text.length * charWidth > width) fontSize = (width / text.length) * 1.4
  const letterSpacing = width / text.length - fontSize
  return { fontSize, letterSpacing: Math.max(-2, Math.min(letterSpacing, 2)) }
}

/**
 * Boxes brighten as the pointer approaches, so the reader can see what is
 * hoverable without the overlay ever being opaque enough to obscure the source.
 */
function proximityStyle(mouse, centerX, centerY, hovering) {
  const distance = Math.hypot(mouse.x - centerX, mouse.y - centerY)
  const proximity = Math.max(0, 1 - distance / PROXIMITY_MAX_DISTANCE)
  return {
    borderBottom: hovering
      ? 'none'
      : `3px solid hsla(210, 100%, ${30 + proximity * 50}%, ${proximity})`,
    backgroundColor: hovering ? 'rgba(0, 0, 0, 0.9)' : 'rgba(0, 0, 0, 0)',
    textOpacity: hovering ? 1 : 0
  }
}

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
    this.lastLookupIndex = null
    this.selectionIndices = new Set()
    /** While the controller reads word by word, boxes stay dark: its outline is the only mark. */
    this.quiet = false
    this.mode = 'words'
    this.frame = null

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

  /** Hold every box unlit and unmarked (true), or let hovering and selection show again. */
  setQuiet(quiet) {
    if (this.quiet === quiet) return
    this.quiet = quiet
    this.updateProximity()
  }

  /**
   * Where each character of a word-mode box is on the source, one cell per code unit of its text
   * (see `characterCells`), from the box OCR found and the lines found inside it, fitted the way
   * grouped text is. Null for anything but a word-mode box.
   */
  charRects(element) {
    const word = this.words.find((candidate) => candidate.element === element)
    if (!word) return null
    const { box } = word
    const vertical = box.orientation === 'vertical' || box.isVertical === true
    const runs = layoutGroup(
      [
        {
          text: box.text,
          rect: { x: box.x, y: box.y, width: box.width, height: box.height },
          lines: word.lines ?? [],
          block: box.granularity === 'block'
        }
      ],
      vertical,
      measureEms
    )
    return characterCells(box.text, runs, vertical, measureEms)
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

  clear() {
    this.renderSignature = null
    this.placementSignature = null
    if (this.container.children.length) this.container.replaceChildren()
    this.words = []
    this.lastLookupIndex = null
    this.selectionIndices = new Set()
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
      this.clear()
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
      return { created: 0, retained: this.container.children.length, removed: 0 }
    this.renderSignature = signature
    const filtered = visibleAnnotations(annotations, grouping)
    if (!filtered.length) {
      this.clear()
      return
    }

    // Existing recognized words remain usable while another request runs.
    // Loading belongs on the controller, not in place of known text.
    const oldWords = new Map(this.words.map((word) => [word.element, word]))
    const oldChildren = [...this.container.children]
    const selected = new Set(
      this.words.filter((word) => this.selectionIndices.has(word.index)).map((word) => word.element)
    )
    const lookup = oldChildren.find((element) => element.ocrIndex === this.lastLookupIndex)
    this.words = []
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
      old.ocrIndex = fresh.ocrIndex
      const ahead = old.querySelector('.ocr-lookahead')
      const nextAhead = fresh.querySelector('.ocr-lookahead')
      if (ahead && nextAhead && ahead.textContent !== nextAhead.textContent)
        ahead.textContent = nextAhead.textContent
      const word = this.words.find((word) => word.element === fresh)
      const previous = oldWords.get(old)
      if (word && previous)
        Object.assign(word, {
          element: old,
          text: previous.text,
          current: previous.current,
          box: previous.box,
          lines: previous.lines,
          centerX: previous.centerX,
          centerY: previous.centerY
        })
      return old
    })
    const keep = new Set(desired)
    for (const element of oldChildren) if (!keep.has(element)) element.remove()
    desired.forEach((element, index) => {
      if (this.container.children[index] !== element)
        this.container.insertBefore(element, this.container.children[index] ?? null)
    })
    this.selectionIndices = new Set(
      this.words.filter((word) => selected.has(word.element)).map((word) => word.index)
    )
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
    const fragment = document.createDocumentFragment()

    mapped.forEach((box, index) => {
      const element = document.createElement('div')
      element.dataset.ocrWordBox = 'true'
      Object.assign(element.style, {
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.width}px`,
        height: `${box.height + 5}px`
      })

      if (scanning) {
        element.className = 'ocr-skeleton'
        element.append(shimmer(box.width, Math.max(box.height * 0.7, 8), box.height * 0.35))
        fragment.append(element)
        return
      }

      const vertical = box.orientation === 'vertical' || box.isVertical === true
      const block = box.granularity === 'block' || box.text.includes('\n')
      element.className = `ocr-word${vertical ? ' ocr-vertical' : ''}${block ? ' ocr-block' : ''}`
      const { fontSize, letterSpacing } = calculateFontSize(box.text, box.width, box.height, vertical)
      Object.assign(element.style, {
        fontSize: `${fontSize}px`,
        letterSpacing: `${letterSpacing}px`,
        lineHeight: `${box.height}px`
      })

      if (vertical || block) {
        const columns = box.text.split('\n')
        const longest = Math.max(1, ...columns.map(line => [...line].length))
        // An unbroken bubble wraps into as many columns/rows as its aspect allows.
        const size = block && columns.length === 1
          ? Math.sqrt(box.width * box.height / Math.max(1, [...box.text].length) / 1.3)
          : Math.min((vertical ? box.width : box.height) / (columns.length * 1.3), (vertical ? box.height : box.width) / longest)
        Object.assign(element.style, { fontSize: `${Math.max(1, Math.min(48, size))}px`, lineHeight: '1.3', letterSpacing: '0px', height: `${box.height}px`, width: `${box.width}px` })
      }
      // The visible word, then the following words: present in the DOM for a lookup
      // to run into, and never seen.
      //
      // The lookahead is scaffolding, so it must not influence where the dictionary
      // popup opens. Yomitan positions the popup from `Range.getClientRects()` of the
      // whole match, and a match that runs past the hovered word into this text takes
      // the following words' layout with it — which put the popup to the right of the
      // word the reader was actually pointing at. Zero font size leaves the text in
      // the DOM, where the scanner reads it by content, and takes it out of the
      // geometry, where it does not belong. `DOMTextScanner` walks nodes and computed
      // display, never rectangles, so this is invisible to it.
      const text = document.createElement('span')
      text.className = 'ocr-word-text'
      const current = document.createElement('span')
      current.className = 'ocr-word-current'
      Object.assign(current.style, {
        width: `${box.width}px`,
        height: `${box.height + 10}px`,
        lineHeight: `${box.height}px`
      })
      if (vertical || block) Object.assign(current.style, { height: `${box.height}px`, lineHeight: '1.3', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' })
      current.textContent = box.text
      const lookahead = document.createElement('span')
      lookahead.className = 'ocr-lookahead'
      lookahead.textContent = mapped
        .slice(index + 1, index + 1 + LOOKAHEAD)
        .filter(next => !box.groupId || next.groupId === box.groupId)
        .map((next) => next.text)
        .join('')
      text.append(current, lookahead)
      element.append(text)

      element.renderKey = JSON.stringify([this.mode, box.text, box.x, box.y, box.width, box.height, box.orientation, box.groupId])
      element.renderText = box.text
      element.renderBox = { x: box.x, y: box.y, width: box.width, height: box.height }
      this.attachInteraction(element, index)
      this.words.push({
        element,
        text,
        current,
        // The lines the engine found inside the box, if any, for placing characters on the source.
        lines: box.lines ?? [],
        index,
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
      element.className = `ocr-group${vertical ? ' ocr-vertical' : ''}`
      element.dataset.ocrWordBox = 'true'
      Object.assign(element.style, {
        left: `${rect.x - GROUP_PADDING_X}px`,
        top: `${rect.y - GROUP_PADDING_Y}px`,
        width: `${rect.width + GROUP_PADDING_X * 2}px`,
        height: `${rect.height + GROUP_PADDING_Y * 2}px`,
        fontSize: `${fontSize}px`,
        lineHeight: String(GROUP_LINE_HEIGHT)
      })
      element.style.setProperty('--backdrop-opacity', String(opacity / 100))

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

      // Each line or word goes where OCR found it, fitted along its length; see text-layout.js.
      const parts = group.annotations.map((annotation) => {
        const box = getBoundingBox(annotation)
        const lines = (annotation.linePolygons ?? [])
          .map((polygon) => {
            const xs = polygon.map((point) => point[0])
            const ys = polygon.map((point) => point[1])
            const x = Math.min(...xs)
            const y = Math.min(...ys)
            return mapRect(info, origin, { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, bounds)
          })
          .filter((line) => line.width > 0 && line.height > 0)
        return {
          text: annotation.description,
          rect: mapRect(info, origin, { x: box.minX, y: box.minY, width: box.width, height: box.height }, bounds),
          lines,
          block: annotation.granularity === 'block'
        }
      })
      const runs = layoutGroup(parts, vertical, measureEms)
      const body = document.createElement('span')
      body.className = 'ocr-runs'
      const left = rect.x - GROUP_PADDING_X + GROUP_BORDER
      const top = rect.y - GROUP_PADDING_Y + GROUP_BORDER
      for (const run of runs) {
        const span = document.createElement('span')
        span.className = 'ocr-run'
        const across = vertical ? run.rect.width : run.rect.height
        Object.assign(span.style, {
          left: `${run.rect.x - left}px`,
          top: `${run.rect.y - top}px`,
          width: `${run.rect.width}px`,
          height: `${run.rect.height}px`,
          fontSize: `${run.fontSize}px`,
          letterSpacing: `${run.spacing}px`,
          lineHeight: `${across}px`,
          [vertical ? 'paddingTop' : 'paddingLeft']: `${Math.max(0, run.lead)}px`
        })
        span.append(document.createTextNode(run.text))
        body.append(span)
      }
      const lookahead = document.createElement('span')
      lookahead.className = 'ocr-lookahead'
      lookahead.textContent = '' // Semantic groups must not extend a lookup into another bubble.
      body.append(lookahead)
      element.append(body)

      const layout = runs.map((run) => [run.text, run.rect.x, run.rect.y, run.rect.width, run.rect.height])
      element.renderKey = JSON.stringify([this.mode, text, rect, layout, opacity, group.orientation])
      element.renderText = text
      element.renderBox = rect
      this.attachInteraction(element, index)
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
    if (this.mode !== 'words' || this.words.length === 0 || this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.updateProximity()
    })
  }

  updateProximity() {
    for (const word of this.words) {
      const { box } = word
      const hovering =
        !this.quiet &&
        (this.selectionIndices.has(word.index) ||
          (this.mouse.x >= box.x &&
            this.mouse.x <= box.x + box.width &&
            this.mouse.y >= box.y &&
            this.mouse.y <= box.y + box.height))
      const far = { x: -100000, y: -100000 }
      const style = proximityStyle(this.quiet ? far : this.mouse, word.centerX, word.centerY, hovering)
      const vertical = box.orientation === 'vertical' || box.isVertical === true
      word.element.style.borderBottom = vertical ? 'none' : style.borderBottom
      word.element.style.borderRight = vertical ? style.borderBottom : 'none'
      word.element.style.backgroundColor = style.backgroundColor
      word.element.style.borderRadius = hovering ? '6px' : '6px 6px 0 0'
      word.element.style.transform = hovering ? 'scale(1.2)' : 'scale(1)'
      word.text.style.opacity = String(style.textOpacity)
      word.current.style.textAlign = hovering ? 'center' : 'left'
    }
  }

  /**
   * Keep every box a selection spans legible.
   *
   * A selection that starts in one box usually runs into the lookahead text of
   * the boxes after it, which is invisible by default. Walking the overflow
   * forward and lighting up those boxes is what makes a multi-word selection
   * readable instead of a single lit box followed by blanks.
   */
  updateSelectionHighlight() {
    if (this.mode !== 'words' || this.words.length === 0) return
    const previous = this.selectionIndices
    const selection = window.getSelection()
    const selected = selection?.toString().trim() ?? ''
    const next = new Set()

    if (selected) {
      const anchor = selection?.anchorNode
      const start =
        anchor?.nodeType === Node.ELEMENT_NODE ? anchor : (anchor?.parentElement ?? null)
      if (start?.closest?.('[data-ocr-word-box]')) {
        for (let i = 0; i < this.words.length; i++) {
          const word = this.words[i].box.text
          if (!selected.startsWith(word)) continue
          next.add(this.words[i].index)
          let overflow = selected.slice(word.length)
          for (let j = i + 1; j < this.words.length && overflow.length > 0; j++) {
            const nextWord = this.words[j].box.text
            if (overflow.startsWith(nextWord)) {
              next.add(this.words[j].index)
              overflow = overflow.slice(nextWord.length)
            } else if (nextWord.startsWith(overflow)) {
              next.add(this.words[j].index)
              break
            }
          }
          break
        }
      }
    }

    if (next.size === previous.size && [...next].every((i) => previous.has(i))) return
    this.selectionIndices = next
    this.updateProximity()
  }
}

export { calculateFontSize, proximityStyle, dispatchEscape, dispatchLookup, getBoundingBox }
