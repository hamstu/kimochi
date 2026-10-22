/**
 * The docs screenshot stage. Reads one shot from ?shot=<JSON> (a resolved entry of
 * site-docs/shots/shots.config.mjs plus `theme` and `url`), frames the harness page in #app and
 * exposes `window.__stage` to the capture script (scripts/docs-screenshots.mjs):
 *
 *   await __stage.ready          the frame loaded and the shot's `ready` selector exists
 *   __stage.point(target)        a target's centre in page coordinates, for real CDP mouse input
 *   __stage.mark()               draws the shot's marks over the window
 *   __stage.clip()               the stage's box, for Page.captureScreenshot
 *
 * A target is a CSS selector, or { selector, text?, index?, pad? }: `text` keeps elements whose
 * text contains it, `index` picks one of the matches (default 0). Selectors run inside the frame.
 */
const shot = JSON.parse(new URLSearchParams(location.search).get('shot') ?? '{}')
const root = document.documentElement
root.dataset.theme = shot.theme ?? 'light'

const stage = document.getElementById('stage')
const win = document.getElementById('window')
const viewport = document.getElementById('viewport')
const frame = document.getElementById('app')
const marks = document.getElementById('marks')
const notes = document.getElementById('notes')

const [width, height] = shot.size ?? [900, 560]

// The social card: wordmark and tagline on the left, the app window running off the right edge.
if (shot.layout === 'og') {
  document.body.classList.add('og')
  stage.insertAdjacentHTML(
    'afterbegin',
    `<div class="og-copy"><div class="og-mark"><img src="/__shots/icon.svg" alt="" /><b>Kimochi</b><span>Docs</span></div>
     <h1>Read your games in Japanese.</h1>
     <p>Install, set up OCR and dictionaries, and read with the overlay, the Log and the Notebook.</p>
     <p class="og-url">docs.kimochiapp.com</p></div>`
  )
}
let crop = shot.crop ?? { x: 0, y: 0, width, height }
// `pad`: one number, or [top, right, bottom, left] to leave room for notes on one side.
const [padTop, padRight, padBottom, padLeft] = [shot.pad ?? 48].flat().length === 4 ? shot.pad : Array(4).fill(shot.pad ?? 48)
stage.style.padding = `${padTop}px ${padRight}px ${padBottom}px ${padLeft}px`
if (shot.radius != null) win.style.setProperty('--radius', `${shot.radius}px`)
if (shot.frame === 'bare') win.classList.add('bare')
if (shot.frame === 'titlebar') {
  const bar = document.getElementById('titlebar')
  bar.hidden = false
  document.getElementById('title').textContent = shot.title ?? 'Kimochi'
}
viewport.style.width = `${crop.width}px`
viewport.style.height = `${crop.height}px`
frame.style.width = `${width}px`
frame.style.height = `${height}px`
frame.style.marginLeft = `${-crop.x}px`
frame.style.marginTop = `${-crop.y}px`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function find(target) {
  const spec = typeof target === 'string' ? { selector: target } : target
  const doc = frame.contentDocument
  if (!doc) return null
  let found = [...doc.querySelectorAll(spec.selector)]
  if (spec.text) found = found.filter((el) => el.textContent?.includes(spec.text))
  return found[spec.index ?? 0] ?? null
}

/** A target's box in window coordinates (the window's top-left is 0,0), padded. */
function box(target) {
  const el = find(target)
  if (!el) throw Error(`No element for ${JSON.stringify(target)}`)
  const r = el.getBoundingClientRect()
  const pad = typeof target === 'object' ? (target.pad ?? 0) : 0
  const top = document.getElementById('titlebar').hidden ? 0 : 30
  return {
    x: r.left - crop.x - pad,
    y: r.top - crop.y + top - pad,
    width: r.width + pad * 2,
    height: r.height + pad * 2
  }
}

async function waitFor(selector, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!find(selector)) {
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${selector}`)
    await sleep(100)
  }
}

const ready = new Promise((resolve, reject) => {
  frame.addEventListener(
    'load',
    async () => {
      try {
        // Fonts first, so measured boxes do not shift after the shot is marked.
        await frame.contentDocument.fonts?.ready
        if (shot.ready) await waitFor(shot.ready)
        await sleep(shot.settle ?? 600)
        resolve(true)
      } catch (error) {
        reject(error)
      }
    },
    { once: true }
  )
  frame.src = shot.url
})

/** Shows only one element of the page (scrolled into view), as if it were the window. */
function clipTo(target) {
  // Of several matches, the biggest one on screen (the site keeps small copies for other layouts).
  const spec = typeof target === 'string' ? { selector: target } : target
  const area = (el) => el.getBoundingClientRect().width * el.getBoundingClientRect().height
  const el = [...frame.contentDocument.querySelectorAll(spec.selector)].sort((a, b) => area(b) - area(a))[0]
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  crop = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
  viewport.style.width = `${crop.width}px`
  viewport.style.height = `${crop.height}px`
  frame.style.marginLeft = `${-crop.x}px`
  frame.style.marginTop = `${-crop.y}px`
}

function place(el, { x, y, width: w, height: h }) {
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  if (w != null) el.style.width = `${w}px`
  if (h != null) el.style.height = `${h}px`
}

const CURSOR = `<svg class="cursor" viewBox="0 0 24 24"><path d="M5 2.5v17.2l4.4-4.1 2.9 6.6 2.9-1.3-2.9-6.5h6.1z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`

/** Where a note sits relative to its target's box, in stage coordinates. */
function notePosition(b, side, note, offset) {
  const gap = offset ?? 28
  const x = padLeft + b.x
  const y = padTop + b.y
  const cx = x + b.width / 2
  const cy = y + b.height / 2
  const w = note.offsetWidth
  const h = note.offsetHeight
  switch (side) {
    case 'left':
      return { x: x - gap - w, y: cy - h / 2, ax: x, ay: cy }
    case 'top':
      return { x: cx - w / 2, y: y - gap - h, ax: cx, ay: y }
    case 'bottom':
      return { x: cx - w / 2, y: y + b.height + gap, ax: cx, ay: y + b.height }
    default:
      return { x: x + b.width + gap, y: cy - h / 2, ax: x + b.width, ay: cy }
  }
}

function mark() {
  for (const m of shot.marks ?? []) {
    const b = box(m.target)
    const radius = `${m.radius ?? 8}px`
    if (m.type === 'glow' || m.type === 'focus') {
      if (m.type === 'focus' || m.dim) {
        const dim = document.createElement('div')
        dim.className = 'focus'
        dim.style.setProperty('--r', radius)
        place(dim, b)
        marks.append(dim)
      }
      if (m.type === 'glow' || m.glow !== false) {
        const glow = document.createElement('div')
        glow.className = 'glow'
        glow.style.setProperty('--r', radius)
        place(glow, b)
        marks.append(glow)
      }
    } else if (m.type === 'badge') {
      const badge = document.createElement('div')
      badge.className = 'badge'
      badge.textContent = String(m.n)
      const at = m.at ?? 'top-left'
      place(badge, {
        x: at.endsWith('right') ? b.x + b.width : b.x,
        y: at.startsWith('bottom') ? b.y + b.height : b.y
      })
      marks.append(badge)
    } else if (m.type === 'note') {
      const note = document.createElement('div')
      note.className = 'note'
      if (m.n != null) {
        const n = document.createElement('span')
        n.className = 'n'
        n.textContent = String(m.n)
        note.append(n)
      }
      note.append(document.createTextNode(m.text))
      notes.append(note)
      const p = notePosition(b, m.side ?? 'right', note, m.offset)
      place(note, p)
      // A dashed leader from the note's near edge to the target's edge, ending in a dot.
      const fromX = m.side === 'left' ? p.x + note.offsetWidth : m.side === 'top' || m.side === 'bottom' ? p.x + note.offsetWidth / 2 : p.x
      const fromY = m.side === 'top' ? p.y + note.offsetHeight : m.side === 'bottom' ? p.y : p.y + note.offsetHeight / 2
      const dx = p.ax - fromX
      const dy = p.ay - fromY
      const leader = document.createElement('div')
      leader.className = 'leader'
      place(leader, { x: fromX, y: fromY, width: Math.hypot(dx, dy) })
      leader.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`
      const dot = document.createElement('div')
      dot.className = 'dot'
      place(dot, { x: p.ax, y: p.ay })
      notes.append(leader, dot)
    } else if (m.type === 'cursor') {
      marks.insertAdjacentHTML('beforeend', CURSOR)
      const cursor = marks.lastElementChild
      place(cursor, { x: b.x + b.width * (m.fx ?? 0.5) - 4, y: b.y + b.height * (m.fy ?? 0.6) - 2 })
    }
  }
}

/** A target's centre in page coordinates (the stage page, which the frame sits inside). */
function point(target) {
  const b = box(target)
  const w = win.getBoundingClientRect()
  return { x: w.left + b.x + b.width / 2, y: w.top + b.y + b.height / 2 }
}

function clip() {
  const r = stage.getBoundingClientRect()
  return { x: r.left, y: r.top, width: Math.ceil(r.width), height: Math.ceil(r.height) }
}

/**
 * Opens a target's context menu. Chrome's headless input does not raise `contextmenu` from CDP
 * mouse presses, so the event is dispatched where a right-click would land.
 */
function contextMenu(target) {
  const el = find(target)
  const r = el.getBoundingClientRect()
  const init = { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: r.left + 40, clientY: r.top + r.height / 2 }
  el.dispatchEvent(new frame.contentWindow.PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }))
  el.dispatchEvent(new frame.contentWindow.MouseEvent('contextmenu', init))
}

/** Runs `code` (a function body) inside the frame, for setup the harness has no parameter for. */
function run(code) {
  return new frame.contentWindow.Function(code)()
}

window.__stage = { ready, point, mark, clip, run, waitFor, clipTo, contextMenu }
