/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The Text Hooker's card on the overlay: the hooked line, always shown, over the game.
 *
 * One element of its own, never drawn through the OCR renderer (render.js fades its boxes in and
 * out as they come and go, which is right for OCR and left a trail behind a card being dragged).
 * It is placed with a transform and nothing about it animates, except a glide when Auto align
 * moves it (`hook-card-glide`, for that one move only). Its text is real text in the overlay's
 * document, so the dictionary looks it up and opens its pop-ups as it does over OCR'd text, and
 * Read along steps through it (ui/overlay.js `hookCardUnits`).
 *
 * Coordinates are the overlay's (CSS pixels from its top-left). `show` places the card's text box:
 * the text starts exactly at `x`, `y`, whatever the padding, so text placed over the game's own
 * lines up with it. The text keeps the size it is given; the box is at least `width` × `height`
 * and grows to fit the line.
 *
 * It looks the same however it is placed. The bar along its top moves it, the corner resizes it,
 * −/+ beside the corner change the text's size, and ⋯ opens a menu (opacity, the game's settings);
 * each tells the overlay (`hooks`), which keeps the result for the game.
 *
 * In Steam Deck Gaming Mode nothing can point at the card, so it is drawn `bare` (the text alone)
 * and the controller places it instead (`steer`, then `release`), from the game menu's Card panel
 * (ui/controller-card.js).
 *
 * The overlay delivers the pointer: presses as DOM events (the Windows hook, host/windows-pointer.js)
 * and position through `pointer(x, y, down)` from the native pointer feed, which keeps a dragged
 * card under the pointer however fast it moves and shows the controls while it is over the card.
 */

/** Padding between the card's edge and its text: the bar above, the controls' row below. */
const PAD_X = 14
const PAD_TOP = 20
const PAD_BOTTOM = 22
const MIN_WIDTH = 60
const MIN_HEIGHT = 16
/** The opacities the menu offers for the card's background. */
export const HOOK_CARD_OPACITIES = [1, 0.85, 0.7, 0.55, 0.4]

/** Lucide's A-arrow-down, A-arrow-up and ellipsis, as the Log's bar draws them. */
const ICONS = {
  smaller: '<path d="M3.5 13h6"/><path d="m2 16 4.5-9 4.5 9"/><path d="M18 7v9"/><path d="m14 12 4 4 4-4"/>',
  larger: '<path d="M3.5 13h6"/><path d="m2 16 4.5-9 4.5 9"/><path d="M18 16V7"/><path d="m14 11 4-4 4 4"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'
}
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`

/**
 * Puts `element` first in `parent`, after only Kimochi's own unscanned controls already there (the
 * overlay's hint bar): ahead of every text that is looked up, so no read runs from that text into
 * a `data-no-scan` node (see `createHookCard`).
 */
function placeBeforeText(parent, element) {
  let next = parent.firstElementChild
  while (next?.hasAttribute('data-no-scan')) next = next.nextElementSibling
  parent.insertBefore(element, next ?? null)
}

const make = (tag, className, attributes = {}) => {
  const element = document.createElement(tag)
  element.className = className
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
  return element
}

/**
 * @param {HTMLElement} parent
 * @param {{ onMoved: (box: {x:number,y:number,width:number,height:number}) => void,
 *           onDrag: (active: boolean) => void,
 *           onTextSize: (step: number, box: {x:number,y:number,width:number,height:number}) => void,
 *           onOpacity: (opacity: number) => void,
 *           onSettings: () => void }} hooks
 */
export function createHookCard(parent, hooks) {
  const card = make('div', 'hook-card')
  card.hidden = true
  const bar = make('div', 'hook-card-bar')
  const text = make('div', 'hook-card-text', { lang: 'ja' })
  const controls = make('div', 'hook-card-controls')
  const smaller = make('button', 'hook-card-button', { type: 'button', 'aria-label': 'Smaller text' })
  smaller.innerHTML = icon('smaller')
  const larger = make('button', 'hook-card-button', { type: 'button', 'aria-label': 'Larger text' })
  larger.innerHTML = icon('larger')
  const more = make('button', 'hook-card-button hook-card-more', { type: 'button', 'aria-label': 'Card options' })
  more.innerHTML = icon('more')
  const corner = make('div', 'hook-card-resize')
  controls.append(smaller, larger, more)
  const menu = make('div', 'hook-card-menu')
  menu.hidden = true
  const opacityLabel = make('div', 'hook-card-menu-label')
  opacityLabel.textContent = 'Opacity'
  const opacities = make('div', 'hook-card-opacities')
  for (const value of HOOK_CARD_OPACITIES) {
    const option = make('button', 'hook-card-opacity', { type: 'button', 'data-opacity': String(value) })
    option.textContent = `${Math.round(value * 100)}%`
    option.addEventListener('click', () => {
      hooks.onOpacity(value)
      menu.hidden = true
    })
    opacities.append(option)
  }
  const settings = make('button', 'hook-card-menu-item', { type: 'button' })
  settings.textContent = 'Text Hooker settings…'
  settings.addEventListener('click', () => {
    menu.hidden = true
    hooks.onSettings()
  })
  menu.append(opacityLabel, opacities, settings)
  // Only the line is looked up: with Shift still held after a click on ⋯, a pointer over the
  // menu or the buttons must not open a dictionary pop-up (`data-no-scan`, host/frontend-mode.js).
  for (const element of [bar, controls, corner, menu]) element.setAttribute('data-no-scan', '')
  // The line comes last, in the card and on the page: nothing marked `data-no-scan` may follow
  // text that is looked up. A read from a line's last word runs out of text and Yomitan leaves its
  // end on the last node it passed; a `data-no-scan` node there costs the word its last character
  // (`食べました` → `食べまし`). Everything around the text is positioned, so this order changes
  // nothing on screen, and the card is drawn over the OCR'd text by its z-index, not its place.
  card.append(bar, controls, corner, menu, text)
  placeBeforeText(parent, card)

  /**
   * The overlay's window never has the pointer (it passes through to the game), so nothing in it
   * gets :hover: the part under the pointer gets `data-hover` instead, from `pointer`.
   */
  const hoverable = [bar, smaller, larger, more, corner, ...opacities.children, settings]
  let hovered = null
  const hover = (element) => {
    if (element === hovered) return
    hovered?.removeAttribute('data-hover')
    element?.setAttribute('data-hover', '')
    hovered = element
  }
  const inside = (element, x, y) => {
    if (element.offsetParent === null) return false
    const r = element.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }

  /** What was last shown, where its text box is now, and a move or resize in progress. */
  let view = null
  let box = null
  let drag = null
  /** The controller is placing the card (`steer`): what is shown keeps its text, not its place. */
  let steered = false
  /** The text shown, its line breaks (`\n`) included: the page's text has none (`setText`). */
  let shown = ''

  /**
   * Shows `value`, one row per line of it. The break after each row but the last is drawn by CSS
   * (hook-card.css), never a `\n` in the page: the dictionary reads the page's characters, so a
   * newline there split a word the game broke across two lines (自転 / 車 looked up as 自転), and
   * Yomitan's Layout-aware scan reads a `<br>` or a block as a newline too. Inline rows with a
   * generated break are neither, so a lookup reads on into the next row, whatever the engine.
   * In a language that spaces its words (`spaced`) the last word of a row and the first of the
   * next are two words, so a row but the last ends in a space (unless it, or the next, has one).
   */
  const setText = (value, spaced = false) => {
    shown = value
    const lines = value.split(/\r?\n/)
    text.replaceChildren(
      ...lines.map((line, index) => {
        const row = make('span', 'hook-card-row')
        const next = lines[index + 1]
        row.textContent = spaced && next && line && !/\s$/u.test(line) && !/^\s/u.test(next) ? `${line} ` : line
        return row
      })
    )
  }

  const clampBox = (b) => {
    const width = Math.max(MIN_WIDTH, Math.min(b.width, innerWidth - PAD_X * 2))
    const height = Math.max(MIN_HEIGHT, b.height)
    return {
      width,
      height,
      x: Math.min(Math.max(b.x, PAD_X), Math.max(PAD_X, innerWidth - width - PAD_X)),
      y: Math.min(Math.max(b.y, PAD_TOP), Math.max(PAD_TOP, innerHeight - height - PAD_BOTTOM))
    }
  }
  const apply = (glide) => {
    card.classList.toggle('hook-card-glide', glide)
    card.style.transform = `translate3d(${box.x - PAD_X}px, ${box.y - PAD_TOP}px, 0)`
    card.style.width = `${box.width + PAD_X * 2}px`
    // The text's own width, not the card's (which glides): what it wraps at is the new one now.
    text.style.width = `${box.width}px`
    text.style.minHeight = `${box.height}px`
  }

  /** How many lines the text wraps onto as laid out now. */
  const linesNow = () => {
    if (!text.textContent) return 0
    const range = document.createRange()
    range.selectNodeContents(text)
    const tops = new Set()
    for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top))
    return tops.size
  }
  /** What the text was last fitted for, so a redraw that changes nothing measures nothing. */
  let fitted = ''
  /**
   * The game shows the line on `lines` lines: the card must not wrap onto more (the card's font
   * is not quite the game's, nor its size quite what OCR measured). The text shrinks, a little
   * at a time and by at most a fifth, for this line only, until it fits.
   */
  const fit = (lines, fontPx) => {
    const key = `${shown}|${fontPx}|${box?.width}|${lines}`
    if (key === fitted) return
    fitted = key
    if (!lines || !box) return
    let size = fontPx
    while (linesNow() > lines && size > fontPx * 0.8) {
      size *= 0.97
      text.style.fontSize = `${size}px`
    }
  }

  /**
   * A copy of the text as it is laid out now, over it and taking nothing from it: no layout, no
   * pointer, no lookups (`data-no-scan`), not read aloud. Before the real text, which stays the
   * card's last child (see above), just after the bar, where it has always been drawn. Its class
   * is its own (hook-card.css styles it as the text), so `.hook-card-text` finds only the real one.
   */
  const ghostOf = () => {
    const ghost = text.cloneNode(true)
    ghost.className = 'hook-card-text-ghost'
    ghost.setAttribute('aria-hidden', 'true')
    ghost.setAttribute('data-no-scan', '')
    ghost.style.left = `${text.offsetLeft}px`
    ghost.style.top = `${text.offsetTop}px`
    ghost.style.width = `${text.offsetWidth}px`
    // Frozen as it looks now: held on one line and faded at its end, it stays so while it fades,
    // whatever the card becomes.
    const now = getComputedStyle(text)
    ghost.style.whiteSpace = now.whiteSpace
    ghost.style.overflow = now.overflow
    ghost.style.height = `${text.offsetHeight}px`
    ghost.style.maskImage = now.maskImage
    bar.after(ghost)
    return ghost
  }
  /**
   * The new text fades in over the old one fading out: quick for a new line; a little softer when
   * it is the same line laid out again (the game's line breaks found, a size measured), so it
   * settles into its new shape rather than blinking out and back. Skipped for reduced motion.
   */
  const crossfade = (ghost, relayout) => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || typeof text.animate !== 'function') {
      ghost?.remove()
      return
    }
    const ms = relayout ? 200 : 140
    for (const old of card.querySelectorAll('.hook-card-text-ghost')) if (old !== ghost) old.remove()
    text.getAnimations().forEach((a) => a.cancel())
    text.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' })
    if (!ghost) return
    const out = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in', fill: 'forwards' })
    out.onfinish = out.oncancel = () => ghost.remove()
  }
  /** The same words, laid out differently (line breaks, spacing). */
  const sameWords = (a, b) => a.replace(/\s/g, '') === b.replace(/\s/g, '')

  function show(next) {
    if (!next) {
      card.hidden = true
      menu.hidden = true
      for (const ghost of card.querySelectorAll('.hook-card-text-ghost')) ghost.remove()
      view = null
      return
    }
    const wasShown = !card.hidden && view !== null
    // A line held on one line until it was placed, now placed: it wraps into its box. The same
    // words, laid out anew, so they settle softly into it rather than a row popping into view.
    const settling = wasShown && card.hasAttribute('data-pending') && !next.pending && shown === next.text
    if (settling) crossfade(ghostOf(), true)
    view = next
    card.hidden = false
    card.dataset.ocrTheme = next.theme ?? 'dark'
    card.toggleAttribute('data-pending', Boolean(next.pending))
    // An example (no line yet, its settings open in the game menu): marked so, and not looked up.
    card.toggleAttribute('data-example', Boolean(next.example))
    text.toggleAttribute('data-no-scan', Boolean(next.example))
    if (next.surface) {
      card.dataset.surface = next.surface.ink
      card.style.setProperty('--ocr-surface-top', next.surface.top)
      card.style.setProperty('--ocr-surface-bottom', next.surface.bottom)
    } else delete card.dataset.surface
    card.style.setProperty('--hook-card-opacity', String(next.opacity ?? 1))
    for (const option of opacities.children)
      option.toggleAttribute('data-current', Number(option.dataset.opacity) === (next.opacity ?? 1))
    const previous = shown
    if (previous !== next.text) {
      // Laid out as it was, before the new text replaces it: the old text's copy fades from here.
      if (wasShown && previous) crossfade(ghostOf(), sameWords(previous, next.text))
      setText(next.text, Boolean(next.spaced))
    }
    text.style.lineHeight = String(next.lineHeight ?? 1.5)
    if (drag || steered) return
    const placed = clampBox(next)
    // Shown again unchanged (the overlay redraws often): leave it, and any glide, alone.
    const same = wasShown && box && ['x', 'y', 'width', 'height'].every((k) => Math.abs(placed[k] - box[k]) < 0.5)
    if (!same) {
      box = placed
      apply(Boolean(next.glide) && wasShown)
    }
    const key = `${shown}|${next.fontPx}|${box.width}|${next.lines}`
    if (key !== fitted) text.style.fontSize = `${next.fontPx}px`
    fit(next.lines, next.fontPx)
    // Held on one line (`pending`): faded at the end only where it runs past the box.
    text.toggleAttribute('data-clipped', Boolean(next.pending) && text.scrollWidth > text.clientWidth + 1)
  }

  /** Starts a move (the bar) or a resize (the corner) from a press at `event`. */
  const begin = (mode) => (event) => {
    if (!view || !box || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    menu.hidden = true
    drag = { mode, x: event.clientX, y: event.clientY, from: { ...box }, moved: false }
    card.classList.remove('hook-card-glide')
    card.toggleAttribute('data-dragging', true)
    hooks.onDrag(true)
  }
  bar.addEventListener('pointerdown', begin('move'))
  corner.addEventListener('pointerdown', begin('size'))
  smaller.addEventListener('click', () => box && hooks.onTextSize(-1, { ...box }))
  larger.addEventListener('click', () => box && hooks.onTextSize(1, { ...box }))
  more.addEventListener('click', () => {
    menu.hidden = !menu.hidden
    hooks.onDrag(false)
  })

  function end() {
    if (!drag) return
    const moved = drag.moved
    drag = null
    card.toggleAttribute('data-dragging', false)
    hover(null)
    hooks.onDrag(false)
    // A press on the bar that never moved is not a move (nor a reason to stop aligning).
    if (box && moved) hooks.onMoved({ ...box })
  }
  // The release can land anywhere (the card may lag a press-and-flick).
  addEventListener('pointerup', end, true)
  addEventListener('pointercancel', end, true)

  /**
   * The pointer, in overlay coordinates, whether its button is down, and whether Shift is held
   * (`armed`): moves a dragged card, and lights the control under it. The card takes the mouse
   * only while Shift is held, so only then does a control light; the open menu takes it anyway.
   * True when the pointer was the card's.
   */
  function pointer(x, y, down, armed = true) {
    if (!drag) {
      const reachable = card.hidden ? [] : armed ? hoverable : menu.hidden ? [] : [...opacities.children, settings]
      hover(reachable.find((element) => inside(element, x, y)) ?? null)
      card.toggleAttribute('data-armed', armed && !card.hidden)
      return false
    }
    if (!down) {
      end()
      return true
    }
    const dx = x - drag.x
    const dy = y - drag.y
    if (Math.abs(dx) + Math.abs(dy) >= 2) drag.moved = true
    const from = drag.from
    box = clampBox(
      drag.mode === 'move'
        ? { ...from, x: from.x + dx, y: from.y + dy }
        : { ...from, width: from.width + dx, height: from.height + dy }
    )
    apply(false)
    return true
  }

  /** The controller places the card's text box at `next` (overlay coordinates); its box as placed. */
  function steer(next) {
    if (card.hidden || !next) return null
    steered = true
    menu.hidden = true
    card.classList.remove('hook-card-glide')
    card.toggleAttribute('data-steering', true)
    box = clampBox(next)
    apply(false)
    return { ...box }
  }
  /** The controller is done placing: kept for the game with `commit`, else back where it was. */
  function release(commit) {
    if (!steered) return
    steered = false
    card.toggleAttribute('data-steering', false)
    if (commit && box) hooks.onMoved({ ...box })
    else box = null
  }

  return {
    show,
    pointer,
    steer,
    release,
    /** Just the text: no bar, no size buttons, no menu, no corner (nothing can point at them). */
    bare: (on) => card.toggleAttribute('data-bare', Boolean(on)),
    dragging: () => drag !== null,
    /** Where the card and its open menu are on the overlay; empty when it is not shown. */
    rects: () => (card.hidden ? [] : [card.getBoundingClientRect(), ...(menu.hidden ? [] : [menu.getBoundingClientRect()])]),
    /** The card's text box now (overlay coordinates), or null. */
    box: () => (box ? { ...box } : null),
    element: card
  }
}
