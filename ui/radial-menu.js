/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The controller menu: a ring of actions that pops in over the game.
 *
 * Pointed at with the left stick, stepped through with the D-pad or arrow keys, and clicked
 * with the mouse. Items sit at even angles clockwise from the top, so with four items each
 * D-pad direction names one item directly. The menu draws and reports; what an item does is
 * the caller's business.
 */

const SVG = 'http://www.w3.org/2000/svg'
const RADIUS = 168
const INNER = 92
const GAP_DEGREES = 3
/** How far the stick must lean before it points at an item. */
export const AIM_THRESHOLD = 0.5
/** How far past an item's edge the stick may stray before the next item takes over. */
export const AIM_HYSTERESIS_DEGREES = 6
/** How far the stick must lean before the pointer shows. */
const POINTER_THRESHOLD = 0.3
/**
 * The pointer's time constant: it closes most of the gap to the stick within a frame or two,
 * enough to blend the controller's discrete reports into a smooth sweep without trailing it.
 */
const POINTER_SMOOTHING_MS = 18

export const ICONS = {
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  dictionary:
    '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  auto: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>'
}

/** A stick's direction in degrees clockwise from the top, in [0, 360). */
function stickDegrees(x, y) {
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360
}

/** How far apart two angles are, the short way round. */
function angleBetween(a, b) {
  const away = Math.abs(a - b) % 360
  return Math.min(away, 360 - away)
}

/**
 * The item a stick angle points at: angles run clockwise from the top. With `current`, that
 * item holds on a little past its edges, so a stick resting on a boundary cannot flicker.
 */
export function itemAt(x, y, count, current = -1) {
  if (count <= 0 || Math.hypot(x, y) < AIM_THRESHOLD) return -1
  const degrees = stickDegrees(x, y)
  const span = 360 / count
  if (
    current >= 0 &&
    current < count &&
    angleBetween(degrees, current * span) <= span / 2 + AIM_HYSTERESIS_DEGREES
  )
    return current
  return Math.floor(((degrees + span / 2) % 360) / span)
}

/**
 * The item a D-pad direction names: the one whose middle lies nearest that direction, the
 * earlier one on a tie. With four items each direction is one item; with three, down falls
 * between the two lower items and takes the first.
 */
export function itemFor(dir, count, current) {
  const target = { up: 0, right: 90, down: 180, left: 270 }[dir]
  if (target === undefined || count <= 0) return current
  let best = 0
  let distance = Infinity
  for (let index = 0; index < count; index++) {
    const angle = (index * 360) / count
    const away = Math.min(Math.abs(angle - target), 360 - Math.abs(angle - target))
    if (away < distance - 0.001) {
      best = index
      distance = away
    }
  }
  return best
}

function polar(degrees, radius) {
  const radians = ((degrees - 90) * Math.PI) / 180
  return [radius * Math.cos(radians), radius * Math.sin(radians)]
}

/** An annular sector from `from` to `to` degrees, clockwise from the top. */
function sectorPath(from, to, outer, inner) {
  const [ax, ay] = polar(from, outer)
  const [bx, by] = polar(to, outer)
  const [cx, cy] = polar(to, inner)
  const [dx, dy] = polar(from, inner)
  const large = to - from > 180 ? 1 : 0
  return `M${ax} ${ay}A${outer} ${outer} 0 ${large} 1 ${bx} ${by}L${cx} ${cy}A${inner} ${inner} 0 ${large} 0 ${dx} ${dy}Z`
}

function icon(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
}

export class RadialMenu {
  /**
   * @param {HTMLElement} host
   * @param {{onChoose: (id: string) => void, onClose: () => void}} hooks
   */
  constructor(host, hooks) {
    this.host = host
    this.hooks = hooks
    this.root = null
    this.items = []
    this.selected = -1
    /** The pointer: where the stick points, where it is drawn, and the frame drawing it. */
    this.aimTarget = null
    this.aimDrawn = null
    this.aimFrame = 0
    this.aimTime = 0
  }

  get open() {
    return this.root !== null && !this.root.classList.contains('cm-leaving')
  }

  /**
   * @param {{x: number, y: number}} center where to draw, in overlay coordinates
   * @param {{id: string, label: string, icon: string, enabled: boolean, detail?: string, lit?: boolean}[]} items
   * @param {'pad'|'keys'} input which button names the hints show
   * @param {number} [initial] the item to start on, so A alone chooses it; nothing when -1
   */
  show(center, items, input = 'pad', initial = -1) {
    this.remove()
    this.items = items
    this.selected = items[initial]?.enabled ? initial : -1
    const root = document.createElement('div')
    root.className = 'cm-root'
    root.innerHTML = '<div class="cm-vignette"></div>'
    const ring = document.createElement('div')
    ring.className = 'cm-ring'
    ring.style.left = `${center.x}px`
    ring.style.top = `${center.y}px`

    const size = RADIUS * 2 + 48
    ring.style.setProperty('--cm-size', `${size}px`)
    ring.style.setProperty('--cm-radius', `${RADIUS}px`)
    const glass = document.createElement('div')
    glass.className = 'cm-glass'
    ring.append(glass)
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('class', 'cm-wedges')
    svg.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`)
    svg.innerHTML = `
      <defs>
        <radialGradient id="cm-glow" cx="0" cy="0" r="${RADIUS}" gradientUnits="userSpaceOnUse">
          <stop offset="0.5" stop-color="var(--cm-accent)" stop-opacity="0.05"/>
          <stop offset="1" stop-color="var(--cm-accent)" stop-opacity="0.55"/>
        </radialGradient>
      </defs>
      <circle class="cm-track" r="${RADIUS + 14}"/>
      <circle class="cm-ticks" r="${RADIUS + 14}"/>
      <circle class="cm-disc" r="${INNER - 10}"/>`
    const span = 360 / items.length
    this.wedges = items.map((item, index) => {
      const middle = index * span
      const path = document.createElementNS(SVG, 'path')
      path.setAttribute(
        'd',
        sectorPath(middle - span / 2 + GAP_DEGREES, middle + span / 2 - GAP_DEGREES, RADIUS, INNER)
      )
      path.setAttribute('class', 'cm-wedge')
      path.dataset.index = String(index)
      svg.append(path)
      return path
    })
    ring.append(svg)
    // The pointer turns every frame the stick moves, so it is its own layer: rotating it
    // repaints nothing else, the glowing wedges and the blurred glass behind them included.
    const pointer = document.createElement('div')
    pointer.className = 'cm-pointer'
    pointer.style.setProperty('--cm-pointer-size', `${INNER * 2}px`)
    pointer.innerHTML = `<svg viewBox="${-INNER} ${-INNER} ${INNER * 2} ${INNER * 2}" aria-hidden="true"><path d="M0 ${-INNER + 4}l-7 11h14z"/></svg>`
    ring.append(pointer)
    this.pointer = pointer
    this.aimTarget = null
    this.aimDrawn = null

    this.labels = items.map((item, index) => {
      const [x, y] = polar(index * span, (RADIUS + INNER) / 2)
      const label = document.createElement('div')
      label.className = 'cm-item'
      label.style.setProperty('--x', `${x}px`)
      label.style.setProperty('--y', `${y}px`)
      label.style.setProperty('--i', String(index))
      if (!item.enabled) label.dataset.disabled = ''
      if (item.lit) label.dataset.lit = ''
      label.innerHTML = `<span class="cm-icon">${icon(item.icon)}</span><span class="cm-label"></span>`
      label.querySelector('.cm-label').textContent = item.label
      if (item.detail) {
        const detail = document.createElement('span')
        detail.className = 'cm-detail'
        detail.textContent = item.detail
        label.append(detail)
      }
      ring.append(label)
      return label
    })

    const middle = document.createElement('div')
    middle.className = 'cm-center'
    middle.innerHTML = `
      <div class="cm-title">Kimochi</div>
      <div class="cm-current"></div>
      <div class="cm-hints">
        <span class="cm-hint"><kbd class="cm-glyph cm-confirm">${input === 'keys' ? '↵' : 'A'}</kbd>Select</span>
        <span class="cm-hint"><kbd class="cm-glyph cm-cancel">${input === 'keys' ? 'esc' : 'B'}</kbd>Close</span>
      </div>`
    this.current = middle.querySelector('.cm-current')
    ring.append(middle)

    // The mouse works too: the overlay passes clicks through except over what it reports as
    // interactive, and the ring is reported while it is open.
    for (const wedge of this.wedges) {
      const index = Number(wedge.dataset.index)
      wedge.addEventListener('mouseenter', () => this.select(index))
      wedge.addEventListener('click', () => {
        this.select(index)
        this.confirm()
      })
    }
    middle.addEventListener('click', () => this.hooks.onClose())

    root.append(ring)
    this.ring = ring
    this.root = root
    this.host.append(root)
    this.renderSelection()
  }

  /** Point with the stick; a stick back at rest keeps whatever was pointed at last. */
  aim(x, y) {
    if (!this.open) return
    const showing = Math.hypot(x, y) >= POINTER_THRESHOLD
    this.pointer.classList.toggle('cm-aiming', showing)
    if (showing) {
      const degrees = stickDegrees(x, y)
      if (this.aimDrawn === null) {
        // Appearing: start where the stick is, not swinging in from wherever it last was.
        this.aimDrawn = degrees
        this.drawPointer()
      }
      this.aimTarget = degrees
      this.animatePointer()
    } else {
      this.aimTarget = null
      this.aimDrawn = null
    }
    const index = itemAt(x, y, this.items.length, this.selected)
    if (index >= 0) this.select(index)
  }

  /** Ease the pointer towards the stick, a frame at a time, until it is there. */
  animatePointer() {
    if (this.aimFrame) return
    this.aimTime = performance.now()
    const step = (now) => {
      this.aimFrame = 0
      if (!this.root || this.aimTarget === null || this.aimDrawn === null) return
      const elapsed = Math.min(now - this.aimTime, 100)
      this.aimTime = now
      // The short way round, so sweeping past straight down never spins the pointer back.
      const gap = ((this.aimTarget - this.aimDrawn + 540) % 360) - 180
      const settled = Math.abs(gap) < 0.05
      this.aimDrawn = settled
        ? this.aimTarget
        : (this.aimDrawn + gap * (1 - Math.exp(-elapsed / POINTER_SMOOTHING_MS)) + 360) % 360
      this.drawPointer()
      if (!settled) this.aimFrame = requestAnimationFrame(step)
    }
    this.aimFrame = requestAnimationFrame(step)
  }

  drawPointer() {
    this.pointer.style.transform = `translate(-50%, -50%) rotate(${this.aimDrawn}deg)`
  }

  /** A D-pad or arrow-key direction. */
  direction(dir) {
    if (!this.open) return
    this.select(itemFor(dir, this.items.length, this.selected))
  }

  select(index) {
    if (index === this.selected || index < 0 || index >= this.items.length) return
    this.selected = index
    this.renderSelection()
  }

  /** Choose the selected item; a disabled one shakes instead. Returns the chosen id, if any. */
  confirm() {
    if (!this.open) return null
    const item = this.items[this.selected]
    if (!item) return null
    if (!item.enabled) {
      const label = this.labels[this.selected]
      label.classList.remove('cm-refuse')
      void label.offsetWidth
      label.classList.add('cm-refuse')
      return null
    }
    this.labels[this.selected].classList.add('cm-chosen')
    this.wedges[this.selected].classList.add('cm-chosen')
    this.hooks.onChoose(item.id)
    return item.id
  }

  renderSelection() {
    this.wedges.forEach((wedge, index) => {
      wedge.classList.toggle('cm-selected', index === this.selected)
      wedge.classList.toggle('cm-disabled', !this.items[index].enabled)
    })
    this.labels.forEach((label, index) =>
      label.classList.toggle('cm-selected', index === this.selected)
    )
    const item = this.items[this.selected]
    this.current.textContent = item
      ? item.enabled
        ? item.label
        : (item.unavailable ?? 'Unavailable')
      : 'Choose an action'
    this.current.classList.toggle('cm-muted', !item || !item.enabled)
  }

  /** Where the ring is, in overlay coordinates, so the overlay can take clicks over it. */
  bounds() {
    if (!this.open) return null
    const rect = this.ring.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }

  /** Animate away; `quick` when an item was chosen, so the action is not kept waiting. */
  close() {
    const root = this.root
    if (!root || root.classList.contains('cm-leaving')) return
    root.classList.add('cm-leaving')
    const done = () => {
      root.remove()
      if (this.root === root) this.root = null
    }
    root.addEventListener('animationend', (event) => event.target === this.ring && done())
    setTimeout(done, 400)
  }

  remove() {
    if (this.aimFrame) cancelAnimationFrame(this.aimFrame)
    this.aimFrame = 0
    this.root?.remove()
    this.root = null
  }
}

export default { RadialMenu, itemAt, itemFor, ICONS }
