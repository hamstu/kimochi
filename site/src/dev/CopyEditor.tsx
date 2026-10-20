/**
 * DEV ONLY: edit the site's copy in place, then hand the edits to an agent to make for real.
 *
 * Loaded from main.tsx behind `import.meta.env.DEV`, so production builds never include it. Turned
 * on from the pill in the bottom-left corner: every text block on the page (headings, paragraphs,
 * list items, links, button labels) becomes editable. Each change is listed in the panel with what
 * it was and what it is now, and "Copy summary" puts them on the clipboard as text to paste back.
 * Changes are kept in localStorage, so a hot reload or a page change does not lose them.
 *
 * It only changes the DOM, never the source: a reload shows the original text again (the panel still
 * lists the change).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

interface Change {
  /** `${path}|${before}`: one change per original text on a page. */
  key: string
  path: string
  where: string
  tag: string
  before: string
  after: string
}

const STORE = 'kimochi-site-copy-edits'
const ON = 'kimochi-site-copy-editing'
const ATTR = 'data-copy-edit'

/** Blocks whose own text is copy. The outermost one with text of its own is the editable unit. */
const BLOCKS =
  'h1,h2,h3,h4,h5,h6,p,li,dt,dd,figcaption,blockquote,label,a,button,span,small,strong,em,b,i,td,th,summary,legend'
/** Not copy: the live demo (the app itself), drawings, and this editor. */
const SKIP = '.kd-stage, svg, iframe, canvas, script, style, [data-copy-editor], [contenteditable="false"]'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage blocked: the panel still works for this page view.
  }
}

const textOf = (el: HTMLElement): string => el.innerText.replace(/ /g, ' ').trim()

const hasOwnText = (el: Element): boolean =>
  [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== '')

/** Where on the page a block is, for finding it in the source: its section and nearest heading. */
function locate(el: HTMLElement): string {
  const parts: string[] = []
  const section = el.closest('section[id], [id]:not(main, #root)')
  if (section) parts.push(`#${section.id}`)
  else if (el.closest('header')) parts.push('header')
  else if (el.closest('footer')) parts.push('footer')
  // The heading this block sits under: the last one before it in its section, else the first in it.
  const scope = el.closest('article, section, li, header, footer, main') ?? document.body
  const headings = [...scope.querySelectorAll<HTMLElement>('h1, h2, h3, h4')].filter((h) => h !== el && !h.contains(el))
  const before = headings.filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
  const heading = before.at(-1) ?? headings[0]
  if (heading) parts.push(`under “${textOf(heading).replace(/\s+/g, ' ').slice(0, 60)}”`)
  return parts.join(' ') || 'page'
}

/** The page's editable blocks: outermost elements with text of their own, outside SKIP. */
function findBlocks(root: Element): HTMLElement[] {
  const found: HTMLElement[] = []
  for (const el of root.querySelectorAll<HTMLElement>(BLOCKS)) {
    if (el.closest(SKIP) || !hasOwnText(el)) continue
    if (found.some((f) => f.contains(el))) continue
    if (el.closest(`[${ATTR}]`) && !el.hasAttribute(ATTR)) continue
    found.push(el)
  }
  return found
}

function summary(changes: Change[]): string {
  const byPath = new Map<string, Change[]>()
  for (const c of changes) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c])
  const quote = (s: string): string => s.split('\n').map((line) => `     > ${line}`).join('\n')
  const lines = [`Website copy edits (${changes.length}), made in the dev copy editor. Please make these in the site's source:`, '']
  for (const [path, list] of byPath) {
    lines.push(`## Page ${path}`, '')
    list.forEach((c, i) => {
      lines.push(`${i + 1}. <${c.tag}> ${c.where}`, '   Before:', quote(c.before), '   After:', quote(c.after), '')
    })
  }
  return lines.join('\n').trimEnd() + '\n'
}

function CopyEditor() {
  const [editing, setEditing] = useState(() => load(ON, false))
  const [open, setOpen] = useState(false)
  const [changes, setChanges] = useState<Change[]>(() => load(STORE, []))
  const [copied, setCopied] = useState(false)
  const originals = useRef(new WeakMap<HTMLElement, string>())
  const [path, setPath] = useState(location.pathname)

  useEffect(() => save(STORE, changes), [changes])
  useEffect(() => save(ON, editing), [editing])

  // The router changes pages without a reload.
  useEffect(() => {
    const timer = setInterval(() => setPath((p) => (p === location.pathname ? p : location.pathname)), 400)
    return () => clearInterval(timer)
  }, [])

  const record = useCallback((el: HTMLElement): void => {
    const before = originals.current.get(el)
    if (before === undefined) return
    const after = textOf(el)
    const key = `${location.pathname}|${before}`
    el.toggleAttribute('data-copy-changed', after !== before)
    setChanges((list) => {
      const rest = list.filter((c) => c.key !== key)
      if (after === before) return rest
      const change: Change = { key, path: location.pathname, where: locate(el), tag: el.tagName.toLowerCase(), before, after }
      const at = list.findIndex((c) => c.key === key)
      if (at === -1) return [...rest, change]
      const next = [...list]
      next[at] = change
      return next
    })
  }, [])

  // Editing on: mark the blocks editable (again whenever React renders more of the page).
  useEffect(() => {
    if (!editing) return
    const root = document.getElementById('root')
    if (!root) return
    const saved = load<Change[]>(STORE, [])
    const mark = (): void => {
      for (const el of findBlocks(root)) {
        if (el.hasAttribute(ATTR)) continue
        if (!originals.current.has(el)) {
          const text = textOf(el)
          // A change kept from before a reload: show it again where the text is plain.
          const kept = saved.find((c) => c.path === location.pathname && c.before === text)
          originals.current.set(el, text)
          if (kept && el.children.length === 0) {
            el.textContent = kept.after
            el.setAttribute('data-copy-changed', '')
          }
        }
        el.setAttribute(ATTR, '')
        el.contentEditable = 'plaintext-only'
        if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true'
        el.spellcheck = true
      }
    }
    mark()
    let queued = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(queued)
      queued = requestAnimationFrame(mark)
    })
    observer.observe(root, { childList: true, subtree: true })

    const editable = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>(`[${ATTR}]`) : null
    const onInput = (event: Event): void => {
      const el = editable(event.target)
      if (el) record(el)
    }
    // Links and buttons are for typing in now, not following or pressing.
    const onClick = (event: MouseEvent): void => {
      const el = editable(event.target)
      if (el && (el.closest('a, button') || el.querySelector('a, button'))) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      const el = editable(event.target)
      if (!el) return
      event.stopPropagation()
      if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        el.blur()
      }
    }
    const onPaste = (event: ClipboardEvent): void => {
      if (!editable(event.target)) return
      event.preventDefault()
      document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') ?? '')
    }
    document.addEventListener('input', onInput, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('paste', onPaste, true)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(queued)
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('paste', onPaste, true)
      for (const el of root.querySelectorAll<HTMLElement>(`[${ATTR}]`)) {
        el.removeAttribute(ATTR)
        el.removeAttribute('contenteditable')
        el.removeAttribute('spellcheck')
      }
    }
  }, [editing, path, record])

  /** Puts a block back as it was, if it is on this page. */
  const revert = (change: Change): void => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-copy-changed]')) {
      if (originals.current.get(el) !== change.before) continue
      if (el.children.length === 0) el.textContent = change.before
      el.removeAttribute('data-copy-changed')
    }
    setChanges((list) => list.filter((c) => c.key !== change.key))
  }

  const copy = async (): Promise<void> => {
    const text = summary(changes)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      document.body.append(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const clear = (): void => {
    if (!confirm(`Forget all ${changes.length} edits? The page keeps its text until you reload.`)) return
    for (const el of document.querySelectorAll('[data-copy-changed]')) el.removeAttribute('data-copy-changed')
    setChanges([])
  }

  return (
    <div data-copy-editor className="fixed bottom-4 left-4 z-[2147483000] flex flex-col items-start gap-2 font-sans text-[13px]">
      {open && (
        <div className="flex max-h-[min(70vh,560px)] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-hairline bg-raised text-ink shadow-pop">
          <div className="flex items-center gap-3 border-b border-hairline px-3.5 py-2.5">
            <span className="font-semibold">Copy editor</span>
            <span className="text-ink-3">dev only</span>
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-ink-2">
              Editing
              <input type="checkbox" checked={editing} onChange={(e) => setEditing(e.target.checked)} className="accent-[var(--k-accent)]" />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {changes.length === 0 ? (
              <p className="px-3.5 py-4 text-ink-3">
                {editing
                  ? 'Click any text on the page and type. Enter or Esc finishes; Shift+Enter for a new line. Changes show up here.'
                  : 'Turn on Editing, then click any text on the page and type.'}
              </p>
            ) : (
              <ol className="divide-y divide-[var(--k-line)]">
                {changes.map((c) => (
                  <li key={c.key} className="group px-3.5 py-2.5">
                    <div className="mb-1 flex items-center gap-2 text-[11px] text-ink-3">
                      <span className="truncate">
                        {c.path} · &lt;{c.tag}&gt; {c.where}
                      </span>
                      <button
                        type="button"
                        onClick={() => revert(c)}
                        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-ink"
                      >
                        Undo
                      </button>
                    </div>
                    <p className="text-ink-3 line-through decoration-[color-mix(in_oklab,currentColor_50%,transparent)]">{c.before}</p>
                    <p className="mt-0.5 text-ink">{c.after}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-hairline px-3.5 py-2.5">
            {changes.length > 0 && (
              <button type="button" onClick={clear} className="rounded-md px-2 py-1 text-ink-3 hover:bg-hover hover:text-ink">
                Clear
              </button>
            )}
            <button
              type="button"
              disabled={changes.length === 0}
              onClick={() => void copy()}
              className="ml-auto rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-contrast disabled:opacity-40"
            >
              {copied ? 'Copied' : 'Copy summary'}
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 rounded-full border border-hairline px-3 py-1.5 font-medium shadow-pop ${editing ? 'bg-accent text-accent-contrast' : 'bg-raised text-ink-2 hover:text-ink'}`}
        title="Copy editor (dev only)"
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M10.5 2.5l3 3L6 13H3v-3z" strokeLinejoin="round" />
        </svg>
        {editing ? 'Editing copy' : 'Edit copy'}
        {changes.length > 0 && (
          <span className={`rounded-full px-1.5 text-[11px] tnum ${editing ? 'bg-white/20' : 'bg-accent text-accent-contrast'}`}>{changes.length}</span>
        )}
      </button>
    </div>
  )
}

const STYLE = `
[${ATTR}] { outline: 1px dashed transparent; outline-offset: 3px; border-radius: 2px; cursor: text; transition: outline-color 100ms; }
[${ATTR}]:hover { outline-color: color-mix(in oklab, var(--k-accent) 55%, transparent); }
[${ATTR}]:focus { outline: 2px solid var(--k-accent); }
[data-copy-changed] { background: color-mix(in oklab, #f2c45f 22%, transparent); }
`

/** Mounts the editor in its own root, outside the site's React tree. */
export function mountCopyEditor(): void {
  const host = document.createElement('div')
  host.setAttribute('data-copy-editor', '')
  document.body.append(host)
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.append(style)
  createRoot(host).render(<CopyEditor />)
}
