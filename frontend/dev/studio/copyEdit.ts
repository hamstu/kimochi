/**
 * DEV-ONLY: the UI studio's copy editing, installed into the frame's document. With it on, text in
 * the window outlines under the pointer and a click edits it in place (the click never reaches the
 * app, so buttons and links can be edited too). Each change is handed to the studio, which lists
 * it with where it was and puts the list on the clipboard for an agent to make in the source.
 *
 * Only the DOM changes. Kept changes are shown again after the frame reloads wherever a block's
 * text still reads as it did before the change.
 */

export interface CopyChange {
  /** `${surface}|${before}`: one change per original text in a surface. */
  key: string
  surface: string
  /** The surface and where in it (a settings page, a welcome step), as the reader saw it. */
  place: string
  /** Where in the window: the heading or dialog it sits under. A note has no before or after. */
  where: string
  tag: string
  before: string
  after: string
  note?: string
}

/** Elements whose own text is copy; the innermost one under the pointer is edited. */
const BLOCKS =
  'h1,h2,h3,h4,h5,h6,p,li,dt,dd,label,a,button,span,small,strong,em,b,td,th,summary,legend,div,[role="menuitem"],[role="option"],[role="tab"]'
const SKIP = 'svg, canvas, script, style, textarea, input, select, iframe, [contenteditable="true"]:not([data-studio-edit])'
const ATTR = 'data-studio-edit'
const STYLE_ID = 'kimochi-studio-copy-style'

const textOf = (el: HTMLElement): string => el.innerText.replace(/ /g, ' ').trim()

const hasOwnText = (el: Element): boolean =>
  [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== '')

/** The innermost element under `target` with text of its own. */
function blockAt(target: EventTarget | null): HTMLElement | null {
  // The frame's elements are another realm's, so `instanceof Element` would never hold.
  let el = (target as Node | null)?.nodeType === Node.ELEMENT_NODE ? (target as HTMLElement) : null
  while (el && el.tagName !== 'BODY') {
    if (el.matches(BLOCKS) && !el.closest(SKIP) && hasOwnText(el)) return el
    el = el.parentElement
  }
  return null
}

/** Where in the window a block is: its dialog, and the nearest heading before it. */
function locate(el: HTMLElement): string {
  const parts: string[] = []
  const dialog = el.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
  const dialogTitle = dialog?.querySelector<HTMLElement>('h1, h2, h3, [id$="title"]')
  if (dialogTitle && dialogTitle !== el) parts.push(`dialog “${textOf(dialogTitle).slice(0, 60)}”`)
  const scope = dialog ?? el.ownerDocument.body
  const headings = [...scope.querySelectorAll<HTMLElement>('h1, h2, h3, h4, legend')].filter(
    (h) => h !== el && !h.contains(el) && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
  )
  const heading = headings.at(-1)
  if (heading && heading !== dialogTitle) parts.push(`under “${textOf(heading).replace(/\s+/g, ' ').slice(0, 60)}”`)
  const label = el.closest<HTMLElement>('[aria-label]')?.getAttribute('aria-label')
  if (!parts.length && label) parts.push(`in “${label}”`)
  return parts.join(', ') || 'window'
}

const CSS = `
html[data-studio-copy] [${ATTR}-hover] { outline: 1.5px dashed #3e63dd; outline-offset: 2px; cursor: text !important; }
html[data-studio-copy] [${ATTR}] { outline: 2px solid #3e63dd; outline-offset: 2px; background: rgba(62, 99, 221, 0.08); cursor: text; }
html[data-studio-copy] [data-studio-changed]:not([${ATTR}]) { background: rgba(255, 214, 10, 0.28); box-shadow: 0 0 0 2px rgba(255, 214, 10, 0.28); border-radius: 2px; }
`

export interface CopyEditHooks {
  surface: string
  place: () => string
  /** Kept changes for this surface, to show again. */
  kept: () => CopyChange[]
  onChange: (change: CopyChange, removed: boolean) => void
}

/** Turn copy editing on in `doc`; returns the function that turns it off again. */
export function installCopyEdit(doc: Document, hooks: CopyEditHooks): () => void {
  const root = doc.documentElement
  root.setAttribute('data-studio-copy', '')
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    doc.head.append(style)
  }
  const originals = new WeakMap<HTMLElement, string>()
  let hovered: HTMLElement | null = null
  let editing: HTMLElement | null = null

  const showKept = (): void => {
    const kept = hooks.kept()
    if (!kept.length) return
    for (const el of doc.body.querySelectorAll<HTMLElement>(BLOCKS)) {
      if (el.children.length || el === editing || el.hasAttribute('data-studio-changed')) continue
      const text = textOf(el)
      const change = kept.find((c) => c.before === text)
      if (!change) continue
      originals.set(el, text)
      el.textContent = change.after
      el.setAttribute('data-studio-changed', '')
    }
  }
  showKept()
  let queued = 0
  const view = doc.defaultView!
  const observer = new MutationObserver(() => {
    view.cancelAnimationFrame(queued)
    queued = view.requestAnimationFrame(showKept)
  })
  observer.observe(doc.body, { childList: true, subtree: true })

  const record = (el: HTMLElement): void => {
    const before = originals.get(el)
    if (before === undefined) return
    const after = textOf(el)
    el.toggleAttribute('data-studio-changed', after !== before)
    hooks.onChange(
      {
        key: `${hooks.surface}|${before}`,
        surface: hooks.surface,
        place: hooks.place(),
        where: locate(el),
        tag: el.tagName.toLowerCase(),
        before,
        after
      },
      after === before
    )
  }

  const finish = (cancel = false): void => {
    const el = editing
    if (!el) return
    editing = null
    if (cancel) el.textContent = originals.get(el) ?? el.textContent
    el.removeAttribute(ATTR)
    el.contentEditable = 'inherit'
    record(el)
  }

  const swallow = (event: Event): void => {
    if (blockAt(event.target) || editing?.contains(event.target as Node)) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
  }
  const onPointerDown = (event: PointerEvent): void => {
    const el = blockAt(event.target)
    if (editing && editing.contains(event.target as Node)) {
      // Placing the caret inside the text being edited.
      event.stopPropagation()
      event.stopImmediatePropagation()
      return
    }
    finish()
    if (!el) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (!originals.has(el)) originals.set(el, textOf(el))
    editing = el
    el.setAttribute(ATTR, '')
    el.contentEditable = 'plaintext-only'
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true'
    el.spellcheck = true
    el.focus()
    const range = doc.createRange()
    range.selectNodeContents(el)
    const selection = view.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  const onKey = (event: KeyboardEvent): void => {
    if (!editing) return
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      finish()
    }
  }
  const onInput = (): void => {
    if (editing) record(editing)
  }
  const onOver = (event: MouseEvent): void => {
    const el = blockAt(event.target)
    if (el === hovered) return
    hovered?.removeAttribute(`${ATTR}-hover`)
    hovered = el
    el?.setAttribute(`${ATTR}-hover`, '')
  }
  const onBlur = (event: FocusEvent): void => {
    if (editing && event.target === editing) finish()
  }

  const options = { capture: true }
  doc.addEventListener('pointerdown', onPointerDown, options)
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerup', 'contextmenu'] as const)
    doc.addEventListener(type, swallow, options)
  doc.addEventListener('keydown', onKey, options)
  doc.addEventListener('input', onInput, options)
  doc.addEventListener('mouseover', onOver, options)
  doc.addEventListener('blur', onBlur, options)

  return () => {
    finish()
    observer.disconnect()
    hovered?.removeAttribute(`${ATTR}-hover`)
    root.removeAttribute('data-studio-copy')
    doc.removeEventListener('pointerdown', onPointerDown, options)
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerup', 'contextmenu'] as const)
      doc.removeEventListener(type, swallow, options)
    doc.removeEventListener('keydown', onKey, options)
    doc.removeEventListener('input', onInput, options)
    doc.removeEventListener('mouseover', onOver, options)
    doc.removeEventListener('blur', onBlur, options)
  }
}

/** The changes as text for an agent: grouped by surface, each with where it is and before/after. */
export function copySummary(changes: readonly CopyChange[]): string {
  const bySurface = new Map<string, CopyChange[]>()
  for (const c of changes) bySurface.set(c.surface, [...(bySurface.get(c.surface) ?? []), c])
  const quote = (s: string): string =>
    s
      .split('\n')
      .map((line) => `     > ${line}`)
      .join('\n')
  const lines = [
    `Kimochi app copy edits (${changes.length}), made in the UI studio. Please make these in the app's source:`,
    ''
  ]
  for (const [, list] of bySurface) {
    lines.push(`## ${list[0].surface}`, '')
    list.forEach((c, i) => {
      if (!c.before) {
        lines.push(`${i + 1}. ${c.place}: ${c.note ?? ''}`, '')
        return
      }
      lines.push(`${i + 1}. ${c.place}: <${c.tag}> ${c.where}`, '   Before:', quote(c.before), '   After:', quote(c.after))
      if (c.note) lines.push(`   Note: ${c.note}`)
      lines.push('')
    })
  }
  return lines.join('\n').trimEnd() + '\n'
}
