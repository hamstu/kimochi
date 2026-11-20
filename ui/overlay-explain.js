/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Explain on the overlay: the text on screen explained by AI, in a card right under the line it
 * explains (over it where there is no room below, beside it for vertical text), in the look of the overlay's own text cards
 * (overlay-text.css: Settings → Overlay → Overlay appearance's light or dark, and its highlight
 * colour), with a notch pointing at the line.
 *
 * Asked for with the Explain shortcut (`explainText`, a toggle) or from the game menu (the
 * radial's Explain, where B closes it again and the right stick scrolls it). Escape closes it too:
 * native takes Escape while the card is open (`explain_card_open`, `dismissOverlay`), which clears
 * the rest of the overlay (its pop-ups and lit text) with it. A word highlighted
 * when it is asked for (looked up, or the one read along is on) is explained first, in the line
 * it is in, which is all that is explained then. It runs the Log's Explain (`explain_run`,
 * src-tauri/src/reader/explain.rs) with the Log's provider, model and prompt, and streams the
 * answer in as Markdown (ui/explain-markdown.ts, built as DOM nodes).
 *
 * The card takes the mouse wherever it is, Shift or not, so it can be scrolled and closed; the
 * overlay never has the pointer, so its × lights from `pointer(x, y)` (`data-hover`), as the hint
 * bar's does.
 *
 * One explanation runs at a time across Kimochi: one asked for in the Log stops this one
 * (`explain:error` "Stopped: …"), and closing the card cancels only its own run. The request ids
 * start far above the Log's, at a place of each window's own (the overlay's, and on GNOME the
 * game menu's host's), so no two windows take each other's events.
 */
import { markdownBlocks } from './explain-markdown.js'
import { boxAt, clusterBoxes, lineBoxes, explainRequest, placeExplanation, wordSpanAt } from './explain-screen.js'
import { explainSettings, providerLabel } from './explain-settings.js'

/**
 * Where this window's request ids start: above any the Log will reach, and in a block of its own
 * (one of a million, each a million ids long), so another window with an Explain card (GNOME's
 * game menu host) does not number its requests the same.
 */
const REQUEST_BASE = 2 ** 40 + Math.floor(Math.random() * 2 ** 20) * 2 ** 20

const SPARKLES =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.94 14.06A2 2 0 0 0 8.5 12.62l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 8.5a2 2 0 0 0 1.44-1.44l1.58-6.14a.5.5 0 0 1 .96 0L14.06 7.06A2 2 0 0 0 15.5 8.5l6.14 1.58a.5.5 0 0 1 0 .96L15.5 12.62a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/></svg>'
/** The Log's refresh icon (lucide's refresh-cw). */
const REFRESH =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>'
const CLOSE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

const make = (tag, className, text) => {
  const element = document.createElement(tag)
  element.className = className
  if (text) element.textContent = text
  return element
}

/** A line's marks as nodes (ui/explain-markdown.ts): text only ever as text. */
function inlineNodes(parts) {
  return parts.map((part) => {
    if (part.kind === 'text') return document.createTextNode(part.text)
    if (part.kind === 'br') return document.createElement('br')
    const element = document.createElement(part.kind)
    if (part.kind === 'code') element.textContent = part.text
    else element.append(...inlineNodes(part.children))
    return element
  })
}

/** An answer's Markdown as nodes. */
export function markdownNodes(markdown) {
  return markdownBlocks(markdown).map((block) => {
    if (block.kind === 'pre') {
      const pre = document.createElement('pre')
      pre.append(make('code', '', block.text))
      return pre
    }
    if (block.kind === 'ul' || block.kind === 'ol') {
      const list = document.createElement(block.kind)
      for (const item of block.items) {
        const li = document.createElement('li')
        li.append(...inlineNodes(item))
        list.append(li)
      }
      return list
    }
    // Headings sit under the card's own title, so they start at h3.
    const element = document.createElement(block.kind === 'h' ? `h${Math.min(6, block.level + 2)}` : 'p')
    element.append(...inlineNodes(block.children))
    return element
  })
}

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Box
 * @typedef {{text: string, before: string, after: string}} Focus
 * @typedef {{sections: string[], word: string | null, focus: Focus | null, wordRect: Box | null, anchor: () => Box | null}} Target
 * @typedef {{text: string, rect: Box, box: Element | null, before?: string, after?: string}} Word
 */

/** A drawn text box's own text (a word box's, without the lookahead it carries for lookups). */
export const boxText = (element) => (element.querySelector('.ocr-word-current') ?? element).textContent ?? ''

const squash = (text) => text.replace(/\s+/g, '')

/**
 * The word a lookup matched, from its range (the selection Yomitan makes, or an extension engine's
 * match), when it is in the overlay's text (`within`: a selector); null otherwise.
 * @returns {Word | null}
 */
export function wordInRange(range, within = '#words, .hook-card') {
  const text = range?.toString().trim()
  const start = range?.startContainer
  const host = start ? (start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement) : null
  if (!text || !host?.closest(within)) return null
  const box = host.closest('.ocr-word, .ocr-group')
  return { text, rect: range.getBoundingClientRect(), box, ...around(range, box ?? host.closest(within)) }
}

/**
 * The text drawn just before and after a range in `scope` (its word box, whose lookahead holds the
 * next words, or the card), for telling apart a word that occurs more than once in its line.
 * @returns {{before: string, after: string}}
 */
export function around(range, scope) {
  if (!scope) return { before: '', after: '' }
  const before = document.createRange()
  before.selectNodeContents(scope)
  before.setEnd(range.startContainer, range.startOffset)
  const after = document.createRange()
  after.selectNodeContents(scope)
  after.setStart(range.endContainer, range.endOffset)
  return { before: before.toString(), after: after.toString() }
}

/**
 * What Explain explains in the scan's text, and where it is drawn. With a highlighted word, the
 * section it is in (the line it is read in); otherwise every section. The anchor is the drawn boxes
 * (`container`'s) whose text is in what is explained and that lie together around the word (or the
 * box with the most text), read again each time: the line or bubble itself, never text across the
 * screen that only shares a few characters with it (`clusterBoxes`).
 * @param {string[]} all the screen's sections
 * @param {HTMLElement} container the drawn text (`#words`)
 * @param {Word | null} word
 * @param {() => string[] | null} [current] the screen's sections now: while given, the anchor is
 *   there only while the line explained is still one of them (with no word, the longest of them),
 *   so new text that keeps a stray box of the old (a "。") does not keep the explanation up
 * @returns {Target}
 */
export function textTarget(all, container, word, current) {
  const own = word?.box ? squash(boxText(word.box)) : ''
  const focus = word ? squash(word.text) : ''
  const section =
    (own && all.find((text) => squash(text).includes(own))) ||
    (focus && all.find((text) => squash(text).includes(focus))) ||
    null
  const sections = section ? [section] : all
  const wanted = squash(sections.join(''))
  // The word's middle, where the anchor grows from; read once, as the word was when asked about.
  const vertical = Boolean(word?.box?.classList?.contains('ocr-vertical'))
  const at = word?.rect ? { x: word.rect.x + word.rect.width / 2, y: word.rect.y + word.rect.height / 2 } : null
  const line = squash(sections.reduce((longest, text) => (text.length > longest.length ? text : longest), ''))
  const anchor = () => {
    if (current && line && !(current() ?? []).some((text) => squash(text) === line)) return null
    const boxes = [...container.querySelectorAll('.ocr-word, .ocr-group')]
      .map((element) => ({ text: squash(boxText(element)), rect: element.getBoundingClientRect() }))
      .filter(({ text, rect }) => text && wanted.includes(text) && rect.width > 0 && rect.height > 0)
    if (!boxes.length) return null
    const rects = boxes.map(({ rect }) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }))
    // Only the line around the word (or, with none, around the box with the most text): short
    // boxes elsewhere whose text is also in it are not part of it (`clusterBoxes`).
    const seed = at
      ? boxAt(rects, at.x, at.y)
      : boxes.reduce((longest, box, index) => (box.text.length > boxes[longest].text.length ? index : longest), 0)
    // A word in horizontal text: its own line, not its whole paragraph (`lineBoxes`).
    return at && !vertical ? lineBoxes(rects, seed) : clusterBoxes(rects, seed)
  }
  const asked = word ? { text: word.text, before: word.before ?? '', after: word.after ?? '' } : null
  return { sections, word: word?.text ?? null, focus: asked, wordRect: word?.rect ?? null, anchor }
}

/**
 * The word drawn at a point of the scan's text (`#words`), as a highlighted word (`wordInRange`):
 * the word itself, found in its box's own text by the language's word breaks (`wordSpanAt`), not
 * the whole box, which can be a whole line OCR read as one. Null off the text, on a space or
 * punctuation, and in a box's lookahead (the next words, carried for lookups).
 * @param {number} x
 * @param {number} y
 * @param {string} [language]
 * @returns {Word | null}
 */
export function wordAtPoint(x, y, language) {
  const box = document.elementFromPoint(x, y)?.closest('#words .ocr-word, #words .ocr-group')
  const at = box ? caretAt(x, y) : null
  if (!at || at.node.nodeType !== Node.TEXT_NODE || !box.contains(at.node)) return null
  if (at.node.parentElement?.closest('.ocr-lookahead')) return null
  const span = wordSpanAt(at.node.data, at.offset, language)
  if (!span) return null
  const range = document.createRange()
  range.setStart(at.node, span.start)
  range.setEnd(at.node, span.end)
  return wordInRange(range)
}

/** Where the caret would go at a point: `{node, offset}`, or null. */
export function caretAt(x, y) {
  const position = document.caretPositionFromPoint?.(x, y)
  if (position) return { node: position.offsetNode, offset: position.offset }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/** How many finished explanations are kept (`answers`). */
const KEPT = 200

/**
 * Finished explanations, by what was asked (`answerKey`): the same line and word asked about again
 * with the same settings replays the answer instead of asking the AI again. Oldest out first.
 * @type {Map<string, string>}
 */
const answers = new Map()

/**
 * What makes two requests the same question: the line, the word and where it is, the lines before
 * it (a "Yes." means something else after another question), and the settings.
 */
function answerKey(request, settings, language) {
  const { provider, model, effort, tier, prompt, focusPrompt } = settings
  return JSON.stringify([
    request.sentence,
    request.word,
    request.at,
    request.context,
    language,
    provider,
    model,
    effort,
    tier,
    prompt,
    focusPrompt
  ])
}

/** Presses this close together (ms) count as a double or triple click. */
const MULTI_CLICK = 450

/**
 * Text selection in `element` from presses the page did not get from the system. On Windows the
 * mouse guard takes the press before the game can (so the game keeps the keyboard) and replays it
 * here as an untrusted event, and a browser starts no selection from those: so it is done here.
 * A drag selects from the press to the pointer (the moves are real), a double click a word and a
 * triple click a paragraph. Real presses (elsewhere) select as usual and are left alone.
 * @param {HTMLElement} element
 */
export function selectable(element) {
  /** Where the drag began, while the button is down. */
  let from = null
  let lastAt = 0
  let presses = 0
  const inside = (at) => at && element.contains(at.node)
  element.addEventListener('mousedown', (event) => {
    if (event.isTrusted || event.button !== 0) return
    const at = caretAt(event.clientX, event.clientY)
    if (!inside(at)) return
    const now = performance.now()
    presses = now - lastAt < MULTI_CLICK ? presses + 1 : 1
    lastAt = now
    const selection = getSelection()
    if (!selection) return
    from = null
    if (presses === 2) {
      selection.collapse(at.node, at.offset)
      selection.modify('move', 'backward', 'word')
      selection.modify('extend', 'forward', 'word')
    } else if (presses >= 3) {
      const node = at.node.nodeType === Node.ELEMENT_NODE ? at.node : at.node.parentElement
      selection.selectAllChildren(node?.closest('p, li, h1, h2, h3, h4, pre, blockquote') ?? element)
    } else {
      selection.collapse(at.node, at.offset)
      from = at
    }
  })
  window.addEventListener('mousemove', (event) => {
    if (!from) return
    const at = caretAt(event.clientX, event.clientY)
    if (inside(at)) getSelection()?.setBaseAndExtent(from.node, from.offset, at.node, at.offset)
  })
  window.addEventListener('mouseup', () => (from = null), true)
}

/**
 * @param {HTMLElement} parent
 * @param {object} context
 * @param {typeof import('./native.js')} context.native
 * @param {(whole?: boolean) => Target} context.target what to explain, read when it is asked for:
 *   the text (a string per section), the highlighted word (none with `whole`: the sentence it is in),
 *   and where the text is drawn (overlay coordinates)
 * @param {() => string} context.language the language being read (a code)
 * @param {() => Box | null} context.area where the source is (overlay coordinates), for when the
 *   text cannot be found on screen
 * @param {() => {theme: 'light' | 'dark', highlight: string, font: string}} context.look the overlay
 *   text's look: its cards' theme, its highlight colour ("r, g, b") and the language's fonts
 * @param {() => void} context.changed the card came, went or moved: what takes the mouse changed
 * @param {() => void} [context.closed] the card closed, however it was closed
 * @param {(record: object) => void} [context.log]
 */
export function createOverlayExplain(parent, context) {
  const { native } = context
  const panel = make('section', 'overlay-explain')
  panel.hidden = true
  panel.setAttribute('aria-label', 'Explain')
  // Kimochi's own words: never looked up with Shift.
  panel.setAttribute('data-no-scan', '')

  const header = make('header', 'overlay-explain-header')
  const icon = make('span', 'overlay-explain-icon')
  icon.innerHTML = SPARKLES
  const title = make('span', 'overlay-explain-title', 'Explain')
  const word = make('span', 'overlay-explain-word')
  const provider = make('span', 'overlay-explain-provider')
  const close = make('button', 'overlay-explain-close')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close')
  close.innerHTML = CLOSE
  close.addEventListener('click', () => hide())
  // As the Log's Explain has: ask again, for a new answer rather than the one kept.
  const refresh = make('button', 'overlay-explain-refresh')
  refresh.type = 'button'
  refresh.setAttribute('aria-label', 'Regenerate')
  refresh.title = 'Regenerate'
  refresh.innerHTML = REFRESH
  refresh.addEventListener('click', () => void regenerate())
  header.append(icon, title, word, provider, refresh, close)

  const body = make('div', 'overlay-explain-body')
  body.setAttribute('aria-live', 'polite')
  panel.append(header, body)
  parent.append(panel)
  selectable(body)

  /** Whether text is selected in the card, as last told to native (`explain_selection`). */
  let selected = false
  /** What is selected in the card, or ''. */
  const selection = () => {
    const current = getSelection()
    if (!current?.rangeCount || !body.contains(current.getRangeAt(0).commonAncestorContainer)) return ''
    return current.toString()
  }
  // The copy shortcut is the overlay's only while there is something of the card's to copy.
  document.addEventListener('selectionchange', () => {
    const now = !panel.hidden && Boolean(selection().trim())
    if (now === selected) return
    selected = now
    void native.invoke('explain_selection', { selected: now }).catch(() => {})
  })

  let counter = 0
  let active = 0
  let text = ''
  /** @type {'loading' | 'streaming' | 'done' | 'error'} */
  let status = 'loading'
  let listening = null
  /** @type {Target | null} what is explained, and where it is drawn */
  let target = null
  /** Where the card was last put (`place`), so an unmoved text writes nothing. */
  let placed = ''
  /** Whether the card has been put by its text, so the text going closes it; cleared each time. */
  let anchored = false
  /** When the explanation in progress was asked for (`performance.now()`). */
  let askedAt = 0
  const elapsed = () => Math.round(performance.now() - askedAt)

  function listen() {
    listening ??= Promise.all([
      native.listen('explain:chunk', ({ payload }) => {
        if (!active || payload?.requestId !== active) return
        // How long the provider took to its first words, to compare providers by.
        if (status === 'loading') context.log?.({ check: 'overlay-explain-first', ms: elapsed() })
        status = 'streaming'
        text += payload.text ?? ''
        render()
      }),
      native.listen('explain:done', ({ payload }) => {
        if (!active || payload?.requestId !== active) return
        status = 'done'
        text = payload.text ?? text
        if (keeping && text.trim()) {
          answers.set(keeping, text)
          if (answers.size > KEPT) answers.delete(answers.keys().next().value)
        }
        keeping = null
        render()
        context.log?.({ check: 'overlay-explain-done', chars: text.length, ms: elapsed() })
      }),
      native.listen('explain:error', ({ payload }) => fail(payload?.requestId, payload?.text))
    ])
    return listening
  }

  function fail(requestId, message) {
    // A finished answer stays: nothing that comes after it (another run taking over) replaces it.
    if (!active || requestId !== active || status === 'done') return
    status = 'error'
    text = String(message || 'The explanation failed.')
    render()
    context.log?.({ check: 'overlay-explain-error', error: text.slice(0, 200) })
  }

  function render() {
    panel.dataset.status = status
    // Not while an answer is being asked for or written, as in the Log.
    refresh.disabled = status === 'loading' || status === 'streaming'
    if (refresh.disabled) refresh.removeAttribute('data-hover')
    if (status === 'error') {
      body.replaceChildren(make('p', 'overlay-explain-error', text))
    } else if (!text) {
      const waiting = make('p', 'overlay-explain-waiting')
      waiting.append(make('span', 'overlay-explain-spinner'), document.createTextNode('Explaining…'))
      body.replaceChildren(waiting)
    } else {
      // An LLM's Markdown is display data, never app code: built as nodes, never parsed as HTML.
      body.replaceChildren(...markdownNodes(text))
    }
    place()
    // Its height follows the answer as it streams in: what takes the mouse changed.
    context.changed()
  }

  /** Under (or over) the text it explains, following it as the source moves. */
  function place() {
    if (panel.hidden || !target) return
    const anchor = target.anchor()
    // The line it was put by is gone (the game behind another window after Alt+Tab, or on to its
    // next line): the explanation goes with it, rather than jumping to the top of the source.
    if (!anchor && anchored) {
      context.log?.({ check: 'overlay-explain-text-gone' })
      return void hide()
    }
    anchored ||= Boolean(anchor)
    const at = placeExplanation(anchor, anchor ? target.wordRect : null, context.area?.() ?? null, {
      width: innerWidth,
      height: innerHeight
    })
    const key = JSON.stringify([at, Boolean(anchor)])
    if (key === placed) return
    placed = key
    panel.dataset.side = at.side
    panel.toggleAttribute('data-notch', Boolean(anchor))
    panel.style.left = `${at.left}px`
    panel.style.width = `${at.width}px`
    panel.style.maxHeight = `${at.maxHeight}px`
    panel.style.top = at.top === null ? 'auto' : `${at.top}px`
    panel.style.bottom = at.bottom === null ? 'auto' : `${at.bottom}px`
    panel.style.setProperty('--explain-caret', `${at.caret}px`)
    context.changed()
  }

  /** The overlay text's look, taken on each time the card opens. */
  function applyLook() {
    const look = context.look()
    panel.dataset.ocrTheme = look.theme
    if (look.highlight) panel.style.setProperty('--ocr-hl-rgb', look.highlight)
    else panel.style.removeProperty('--ocr-hl-rgb')
    if (look.font) panel.style.setProperty('--kimochi-text-font', look.font)
    else panel.style.removeProperty('--kimochi-text-font')
  }

  /** Explain what is on screen now (the highlighted word first). False when there is nothing. */
  /** What a target asks about: its text and highlighted word (where it is drawn aside). */
  const targetKey = (asked) =>
    asked && JSON.stringify([asked.sections, asked.word, asked.focus?.before ?? '', asked.focus?.after ?? ''])

  /** The answer being written, to keep once it is finished (`answers`); null when not to keep. */
  let keeping = null

  /**
   * Ask again about what the card explains, for a new answer: the one kept for it (`answers`) is
   * not replayed, and the new one takes its place once it is written.
   */
  function regenerate() {
    if (panel.hidden || !target || refresh.disabled) return false
    context.log?.({ check: 'overlay-explain-regenerate' })
    return show(target, { fresh: true })
  }

  /**
   * @param {Target} [asked]
   * @param {{fresh?: boolean}} [options] `fresh`: ask the AI even if an answer to this is kept
   */
  async function show(asked = context.target(), { fresh = false } = {}) {
    // First, before anything waits: the highlighted word is read as it is now.
    askedAt = performance.now()
    target = asked
    placed = ''
    anchored = false
    const recent = await native.invoke('log_recent', { limit: 50 }).catch(() => [])
    if (target !== asked) return false
    const stored = native.getSetting('superTexthooker')
    const language = context.language()
    const request = explainRequest(
      asked.sections,
      Array.isArray(recent) ? recent : [],
      stored,
      language,
      asked.focus ?? asked.word
    )
    const settings = explainSettings(stored)
    const key = request ? answerKey(request, settings, language) : null
    keeping = null
    const requestId = REQUEST_BASE + ++counter
    if (active) void native.invoke('explain_cancel', { requestId: active }).catch(() => {})
    active = requestId
    applyLook()
    word.textContent = request?.word ?? ''
    word.hidden = !request?.word
    word.lang = language
    provider.textContent = providerLabel(settings)
    // Escape closes the card while it is open (native takes it from the game until then).
    if (panel.hidden) void native.invoke('explain_card_open', { open: true }).catch(() => {})
    panel.hidden = false
    body.scrollTop = 0
    if (!request) {
      // Said rather than doing nothing, so the shortcut is never dead.
      status = 'error'
      text = 'There is no text on screen to explain yet: scan it first, or wait for the next line.'
      render()
      return false
    }
    const kept = fresh ? undefined : answers.get(key)
    if (kept !== undefined) {
      // Asked before: the same answer again, at once.
      answers.delete(key)
      answers.set(key, kept)
      active = 0
      text = kept
      status = 'done'
      render()
      context.log?.({ check: 'overlay-explain-replayed', chars: kept.length, word: Boolean(request.word) })
      return true
    }
    keeping = key
    text = ''
    status = 'loading'
    render()
    context.log?.({
      check: 'overlay-explain',
      provider: settings.provider,
      model: settings.model,
      effort: settings.effort,
      tier: settings.tier,
      chars: request.sentence.length,
      word: Boolean(request.word)
    })
    await listen()
    // Closed (or asked again) while the listeners were set up: this run is not wanted any more.
    if (active !== requestId) return false
    try {
      await native.invoke('explain_run', {
        requestId,
        provider: settings.provider,
        model: settings.model,
        effort: settings.effort,
        tier: settings.tier,
        prompt: request.prompt
      })
    } catch (error) {
      fail(requestId, error?.message ?? error)
    }
    return true
  }

  function hide() {
    // An opening still waiting (for the Log's lines) is called off as well: `show` checks it.
    target = null
    if (panel.hidden) return
    const requestId = active
    active = 0
    target = null
    anchored = false
    panel.hidden = true
    // Escape (and the copy shortcut) go back to the game.
    selected = false
    void native.invoke('explain_card_open', { open: false }).catch(() => {})
    close.removeAttribute('data-hover')
    refresh.removeAttribute('data-hover')
    body.replaceChildren()
    if (requestId && status !== 'done' && status !== 'error')
      void native.invoke('explain_cancel', { requestId }).catch(() => {})
    context.changed()
    context.closed?.()
  }

  return {
    get shown() {
      return !panel.hidden
    },
    show,
    hide,
    /**
     * The Explain shortcut: explain the text on screen (`whole`: the whole sentence, not the word
     * pointed at). With the card open, something else asked about (another word, the same word in
     * another line, or the sentence after a word) is explained in its place; otherwise the card
     * closes.
     */
    press(whole = false) {
      const asked = context.target(whole)
      if (panel.hidden) return show(asked)
      if ((!whole && !asked.word) || targetKey(asked) === targetKey(target)) {
        hide()
        return false
      }
      return show(asked)
    },
    /** The right stick, from the game menu: scroll the explanation. */
    scroll(y) {
      body.scrollBy(0, -y * 80)
    },
    /** The text moved with its source: follow it. */
    place,
    /** The pointer in overlay coordinates: lights the button under it (× or refresh). */
    pointer(x, y) {
      if (panel.hidden) return
      for (const button of [close, refresh]) {
        const r = button.getBoundingClientRect()
        const over = !button.disabled && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
        button.toggleAttribute('data-hover', over)
      }
    },
    regenerate,
    /**
     * Ctrl+C with the card open (`copyExplanation`): the text selected in it goes to the
     * clipboard. The game keeps the keyboard, so the card never sees the key itself.
     */
    copy() {
      const copied = selection()
      if (panel.hidden || !copied.trim()) {
        return void context.log?.({ check: 'overlay-explain-copy-empty', shown: !panel.hidden })
      }
      void native
        .invoke('explain_copy', { text: copied })
        .then(() => context.log?.({ check: 'overlay-explain-copied', chars: copied.length }))
        .catch((error) => context.log?.({ check: 'overlay-explain-copy-failed', error: String(error) }))
    },
    /** The card while it is shown (overlay coordinates): it takes the mouse, Shift or not. */
    rects: () => (panel.hidden ? [] : [panel.getBoundingClientRect()]),
    element: panel
  }
}
