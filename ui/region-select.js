/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The region editor: draw a box on the screen, adjust it, confirm it. One implementation for both
 * callers — "Select region" on a screen source and Quick Shot — which differ only in what they do
 * with the rectangle afterwards. It is a DOM helper with no framework and no backend calls: it
 * returns a rectangle and nothing else.
 *
 * ## Interaction
 *
 * Drag to draw. The frame and its size readout follow the pointer; the readout lives in the frame's
 * thick bottom edge (the "foot"), which flips above the box near the bottom of the display and
 * slides left near its right side, so it is always on screen. Letting go does not commit: the box
 * becomes editable — drag inside or on the foot to move it, drag an edge or corner to resize, the
 * arrow keys nudge it — and Return, a double-click inside, or the foot's confirm button commits.
 * Escape cancels at any point. Dragging outside an existing box starts a new one.
 *
 * ## Limits and a picture
 *
 * `area` limits drawing, moving and resizing to one rectangle of the surface (a window's bounds),
 * and presses outside it do nothing. `initial` opens with an existing box, ready to adjust.
 * `picture` dims everything and shows an image at that rectangle — a recent screenshot of the
 * window being edited, refreshed with `setPicture`, crossfading — so the window stands out even
 * when other windows cover it.
 *
 * While drawing, holding Space moves the box with the pointer instead of resizing it; letting go
 * carries on drawing from where the box now is.
 *
 * Any size of box is kept — it can be adjusted afterwards — except a plain click, which draws
 * nothing.
 *
 * Until a box exists, a small bubble rides just above the cursor saying what to do. It follows the
 * container's own pointer events, and `pointerAt` for callers that track the pointer themselves (a
 * non-key panel sees no hover events). Drawing hides it.
 *
 * The frame sits *outside* the selected area, so it never covers what is being chosen.
 *
 * ## Coordinates
 *
 * Everything here is in points, never pixels: CSS points inside the window, desktop points outside.
 * There is no `devicePixelRatio` anywhere in this file; converting points to capture pixels needs
 * the display's `scale_factor` (capture pixels per desktop point: the Retina backing scale on
 * macOS, the DPI scale on Windows), which only the caller knows.
 *
 * ## Two call shapes
 *
 *     await selectRegion(container)    // -> {x, y, width, height} in this window's CSS pixels, or
 *                                      //    null. Mounts into `container`. Never rejects.
 *     await selectRegion({ bounds })   // -> {local, desktop, bounds}, or null. `bounds` is the
 *                                      //    display in desktop points, so `desktop` is filled in.
 *
 * ## Click-through
 *
 * The overlay is click-through except where it publishes interactive rectangles to the native side.
 * A caller that publishes its own full-display region needs nothing here; otherwise pass
 * `onHitRects` with the bounds form and publish what it reports (the display while active, empty
 * once the run ends).
 */

const Z_INDEX_OVERLAY = 6000

/** A box needs some size in both axes: a plain click draws nothing. */
const MINIMUM_DRAG = 1

/** The cursor bubble: its gap above the cursor, and how quickly it catches up (0–1 per frame). */
const BUBBLE_GAP = 16
const BUBBLE_EASE = 0.3

const nextFrame = (callback) =>
  globalThis.requestAnimationFrame?.(callback) ?? setTimeout(callback, 16)
const cancelFrame = (id) =>
  globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame(id) : clearTimeout(id)

/** Frame geometry, in points: the ring around the box and the thick edge holding the controls. */
const RING = 4
const FOOT = 28
/** How far from an edge a press still grabs it. */
const GRAB = 8

const THEMES = {
  dark: {
    accent: '#5b7bf0',
    tint: 'rgba(91, 123, 240, 0.10)',
    lift: '0 10px 28px rgba(0, 0, 0, 0.45)',
    highlight: 'rgba(255, 255, 255, 0.38)',
    shade: 'rgba(0, 0, 0, 0.45)',
    hint: 'rgba(24, 25, 27, 0.94)',
    hintText: '#edeef0',
    hintEdge: 'rgba(255, 255, 255, 0.1)',
    keyBg: 'rgba(255, 255, 255, 0.1)',
    keyEdge: 'rgba(255, 255, 255, 0.22)'
  },
  light: {
    accent: '#3e63dd',
    tint: 'rgba(62, 99, 221, 0.08)',
    lift: '0 10px 28px rgba(0, 0, 0, 0.22)',
    highlight: 'rgba(255, 255, 255, 0.5)',
    shade: 'rgba(0, 0, 0, 0.3)',
    hint: 'rgba(255, 255, 255, 0.97)',
    hintText: '#1c2024',
    hintEdge: 'rgba(0, 0, 0, 0.1)',
    keyBg: 'rgba(0, 0, 0, 0.04)',
    keyEdge: 'rgba(0, 0, 0, 0.18)'
  }
}

const MONO = 'ui-monospace, "SF Mono", Menlo, monospace'
const UI = 'system-ui, -apple-system, sans-serif'

const CURSORS = {
  l: 'ew-resize',
  r: 'ew-resize',
  t: 'ns-resize',
  b: 'ns-resize',
  tl: 'nwse-resize',
  br: 'nwse-resize',
  tr: 'nesw-resize',
  bl: 'nesw-resize',
  move: 'move',
  outside: 'crosshair'
}

function assign(element, styles) {
  Object.assign(element.style, styles)
  return element
}

function rectangleFrom(start, end) {
  return {
    x: Math.round(Math.min(start.x, end.x)),
    y: Math.round(Math.min(start.y, end.y)),
    width: Math.round(Math.abs(end.x - start.x)),
    height: Math.round(Math.abs(end.y - start.y))
  }
}

function isRect(value) {
  return (
    value &&
    [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
    value.width > 0 &&
    value.height > 0
  )
}

const bigEnough = (rect) =>
  isRect(rect) && rect.width >= MINIMUM_DRAG && rect.height >= MINIMUM_DRAG

function systemTheme() {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * Which part of `rect` a point is on: an edge or corner (`l`, `tr`, ...), `move` inside, or
 * `outside`.
 */
function zoneOf(point, rect) {
  const within = (value, low, high) => value >= low - GRAB && value <= high + GRAB
  if (!within(point.x, rect.x, rect.x + rect.width)) return 'outside'
  if (!within(point.y, rect.y, rect.y + rect.height)) return 'outside'
  const near = (value, edge) => Math.abs(value - edge) <= GRAB
  const vertical = near(point.y, rect.y) ? 't' : near(point.y, rect.y + rect.height) ? 'b' : ''
  const horizontal = near(point.x, rect.x) ? 'l' : near(point.x, rect.x + rect.width) ? 'r' : ''
  return vertical + horizontal || 'move'
}

/**
 * One editor. A single instance may be started repeatedly; only one run is active at a time, and
 * starting again cancels the previous run rather than stacking surfaces.
 */
export class RegionSelect {
  /**
   * @param {{onHitRects?: Function, container?: HTMLElement, cancelOnMisclick?: boolean,
   *   confirmLabel?: string, alternateLabel?: string, theme?: 'light' | 'dark', area?: object,
   *   initial?: object, picture?: object}} options `area`, `initial` and `picture` are
   *   rectangles in surface points; see above. `alternateLabel` adds a second, outlined confirm
   *   button left of the primary one; the result's `action` says which committed it (`primary`
   *   for Return and a double-click too).
   */
  constructor({
    onHitRects,
    container,
    cancelOnMisclick = false,
    confirmLabel = 'Confirm',
    alternateLabel = null,
    theme,
    area = null,
    initial = null,
    picture = null
  } = {}) {
    this._area = isRect(area) ? { ...area } : null
    this._initial = isRect(initial) ? { ...initial } : null
    this._picture = isRect(picture) ? { ...picture } : null
    this._pictureUrl = null
    this._pristine = false
    this._pointer = null
    this._bubble = null
    this._frame = 0
    this._onHitRects = onHitRects
    this._mount = container ?? null
    this._cancelOnMisclick = cancelOnMisclick
    this._confirmLabel = confirmLabel
    this._alternateLabel = alternateLabel
    this._theme = theme
    this._bounds = null
    this._container = null
    this._els = null
    this._rect = null
    this._editing = false
    this._gesture = null
    this._settle = null
    this._detach = []
  }

  /** True while the editor is on screen. */
  get active() {
    return this._container !== null
  }

  /** True while a box is being drawn, moved or resized: callers hold off background work. */
  get dragging() {
    return this._gesture !== null
  }

  /** True while the box is still the `initial` one (or `reset`'s), untouched. */
  get pristine() {
    return this.active && this._pristine && !this._gesture
  }

  /**
   * Start over with `initial` (or no box), as if just opened: for a caller that moved the surface
   * to another display, where the old box means nothing.
   */
  reset(initial = null) {
    if (!this._els) return
    this._gesture = null
    this._rect = isRect(initial) ? this._clampMove({ ...initial }) : null
    this._editing = this._rect !== null
    this._pristine = this._rect !== null
    this._draw()
  }

  /**
   * Show `url` in the picture rectangle, fading in over the previous image. The image is decoded
   * before it is added, off the main thread where the engine allows: a full-size screenshot
   * decoded in place would stall a drag in progress.
   */
  async setPicture(url) {
    const els = this._els
    if (!els?.stage || !url || url === this._pictureUrl) return
    this._pictureUrl = url
    const image = assign(document.createElement('img'), {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      opacity: '0',
      transition: 'opacity 500ms ease-out'
    })
    image.alt = ''
    image.draggable = false
    image.decoding = 'async'
    image.src = url
    try {
      await image.decode()
    } catch {
      return
    }
    // Superseded or closed while decoding.
    if (this._els !== els || this._pictureUrl !== url) return
    els.stage.append(image)
    // Two paints at opacity 0 first, or the fade would be skipped.
    nextFrame(() =>
      nextFrame(() => {
        image.style.opacity = '1'
        setTimeout(() => {
          for (const old of [...els.stage.children]) if (old !== image) old.remove()
        }, 560)
      })
    )
  }

  /** True while there is no box and nothing being dragged: the cursor bubble is up. */
  get idle() {
    return this.active && !this._rect && !this._gesture
  }

  /**
   * Where the pointer is, in this surface's points, or null when it is off the surface. For
   * callers that track the pointer natively; the surface's own pointer events also feed this.
   * `snap` moves the bubble there at once instead of easing (after the surface itself moved).
   */
  pointerAt(point, { snap = false } = {}) {
    if (!this._els) return
    this._pointer = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null
    if (snap) this._bubble = null
    this._drawBubble()
  }

  /** The current box in overlay-local points, or null. */
  get rect() {
    return this._rect ? { ...this._rect } : null
  }

  /**
   * Interactive rectangles in DESKTOP points, for the native click-through hit test.
   * Empty when inactive, so the caller can publish this value in both directions.
   */
  get hitRects() {
    if (!this._bounds || !this.active) return []
    const { x, y, width, height } = this._bounds
    return [{ x, y, width, height }]
  }

  /**
   * Runs the editor.
   *
   * @param {{bounds?: {x:number,y:number,width:number,height:number}, signal?: AbortSignal,
   *   container?: HTMLElement}} options `bounds` is the display this overlay covers, in desktop
   *   points.
   * @returns {Promise<{local: object, desktop: object|null, bounds: object|null} | null>}
   */
  start({ bounds, signal, container } = {}) {
    if (bounds !== undefined && !isRect(bounds)) {
      return Promise.reject(new Error('Region selection needs the display bounds it covers.'))
    }
    if (container) this._mount = container
    // A second start supersedes the first; the earlier caller is told it was cancelled.
    this.cancel()

    this._bounds = bounds ? { ...bounds } : null
    this._rect = null
    this._editing = false
    this._pristine = false
    this._render()
    if (this._initial) this.reset(this._initial)
    this._publishHitRects()

    return new Promise((resolve) => {
      this._settle = (result) => {
        this._settle = null
        this._teardown()
        resolve(result)
      }

      if (signal) {
        if (signal.aborted) return this._settle(null)
        this._listen(signal, 'abort', () => this._settle?.(null))
      }

      this._listen(document, 'keydown', (event) => this._key(event))
      this._listen(document, 'keyup', (event) => this._keyUp(event))
      this._listen(this._container, 'pointerdown', (event) => this._begin(event))
      this._listen(this._container, 'pointermove', (event) => this._update(event))
      this._listen(this._container, 'pointerup', (event) => this._finish(event))
      this._listen(this._container, 'pointercancel', (event) => this._abandon(event))
      this._listen(this._container, 'lostpointercapture', (event) => this._abandon(event))
      this._listen(this._container, 'dblclick', (event) => {
        if (this._editing && zoneOf(this._point(event), this._rect) === 'move') this.confirm()
      })
    })
  }

  /**
   * Commits the current box, if there is one worth committing.
   * @param {'primary' | 'alternate'} [action] which confirm button committed it
   */
  confirm(action = 'primary') {
    if (!this._settle || !this._editing || !bigEnough(this._rect)) return
    const local = { ...this._rect }
    this._settle(
      this._bounds
        ? {
            action,
            local,
            desktop: {
              x: local.x + this._bounds.x,
              y: local.y + this._bounds.y,
              width: local.width,
              height: local.height
            },
            bounds: { ...this._bounds }
          }
        : { action, local, desktop: null, bounds: null }
    )
  }

  /** Cancels a running editor; its promise resolves with null. Safe to call when inactive. */
  cancel() {
    this._settle?.(null)
  }

  /** Removes everything this instance put in the document. Safe to call more than once. */
  destroy() {
    this.cancel()
    this._teardown()
  }

  // ---------------------------------------------------------------- input

  _listen(target, type, handler, options) {
    target.addEventListener(type, handler, options)
    this._detach.push(() => target.removeEventListener(type, handler, options))
  }

  _point(event) {
    // The surface covers the window exactly, so client coordinates are overlay-local points.
    const rect = this._container.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  _viewport() {
    const rect = this._container.getBoundingClientRect()
    return { width: rect.width ?? Infinity, height: rect.height ?? Infinity }
  }

  _key(event) {
    if (event.key === ' ') {
      event.preventDefault()
      // Held while drawing: the box moves with the pointer until Space is let go.
      if (this._gesture?.kind === 'draw') {
        this._gesture.spacing = true
        this._container.style.cursor = 'move'
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      this._settle?.(null)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      this.confirm()
    } else if (this._editing && !this._gesture && event.key.startsWith('Arrow')) {
      event.preventDefault()
      this._pristine = false
      const step = event.shiftKey ? 10 : 1
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      this._rect = this._clampMove({ ...this._rect, x: this._rect.x + dx, y: this._rect.y + dy })
      this._draw()
    }
  }

  _keyUp(event) {
    if (event.key !== ' ') return
    event.preventDefault()
    if (this._gesture?.kind === 'draw') {
      this._gesture.spacing = false
      this._container.style.cursor = CURSORS.outside
    }
  }

  _begin(event) {
    if (event.button !== 0 || this._gesture) return
    event.preventDefault()
    const point = this._point(event)
    const zone = this._editing ? zoneOf(point, this._rect) : 'outside'
    // Outside the area there is nothing to select.
    if (zone === 'outside' && !this._inArea(point)) return
    this._pristine = false
    this._container.setPointerCapture(event.pointerId)
    if (zone === 'outside') {
      this._editing = false
      this._rect = null
      this._gesture = { kind: 'draw', start: point, pointerId: event.pointerId }
    } else {
      this._gesture = {
        kind: zone === 'move' ? 'move' : 'resize',
        edges: zone,
        start: point,
        from: { ...this._rect },
        pointerId: event.pointerId
      }
    }
    this._draw()
  }

  /** The foot's own background is a handle for moving the box; its edge still resizes. */
  _beginMove(event) {
    if (event.button !== 0 || this._gesture || !this._editing) return
    // Over the box's edge (the handles draw above the foot), let the surface start a resize.
    if (zoneOf(this._point(event), this._rect) !== 'outside') return
    this._pristine = false
    event.preventDefault()
    event.stopPropagation()
    this._container.setPointerCapture(event.pointerId)
    this._gesture = {
      kind: 'move',
      start: this._point(event),
      from: { ...this._rect },
      pointerId: event.pointerId
    }
  }

  _update(event) {
    const gesture = this._gesture
    if (!gesture) this.pointerAt(this._point(event))
    if (!gesture) {
      const point = this._point(event)
      const zone = this._editing ? zoneOf(point, this._rect) : 'outside'
      this._container.style.cursor =
        zone === 'outside' && !this._inArea(point) ? 'default' : CURSORS[zone]
      return
    }
    if (gesture.pointerId !== event.pointerId) return
    const point = this._clampPoint(this._point(event))
    if (gesture.kind === 'draw') {
      // With Space held the start travels with the pointer, so the whole box moves.
      if (gesture.spacing && gesture.last) {
        gesture.start = this._clampPoint({
          x: gesture.start.x + point.x - gesture.last.x,
          y: gesture.start.y + point.y - gesture.last.y
        })
      }
      gesture.last = point
      this._rect = rectangleFrom(gesture.start, point)
    } else if (gesture.kind === 'move') {
      const { from, start } = gesture
      this._rect = this._clampMove({
        ...from,
        x: from.x + point.x - start.x,
        y: from.y + point.y - start.y
      })
    } else {
      const { from, edges } = gesture
      let left = from.x
      let top = from.y
      let right = from.x + from.width
      let bottom = from.y + from.height
      if (edges.includes('l')) left = point.x
      if (edges.includes('r')) right = point.x
      if (edges.includes('t')) top = point.y
      if (edges.includes('b')) bottom = point.y
      // Dragging an edge past its opposite flips the box rather than inverting it.
      this._rect = rectangleFrom({ x: left, y: top }, { x: right, y: bottom })
    }
    this._draw()
  }

  _finish(event) {
    const gesture = this._gesture
    if (gesture?.pointerId !== event.pointerId) return
    this._gesture = null
    if (this._container.hasPointerCapture(event.pointerId)) {
      this._container.releasePointerCapture(event.pointerId)
    }
    if (gesture.kind === 'draw') {
      this._rect = rectangleFrom(gesture.start, this._clampPoint(this._point(event)))
    }
    // An edit that collapses the box to nothing is undone; the box stays as it was.
    if (gesture.kind !== 'draw' && !bigEnough(this._rect)) {
      this._rect = gesture.from
      this._draw()
      return
    }
    // A click without a drag draws nothing: stay open for another attempt, bubble back at the
    // cursor.
    if (!bigEnough(this._rect)) {
      this._rect = null
      this._editing = false
      this._pointer = this._point(event)
      this._bubble = null
      this._draw()
      if (this._cancelOnMisclick) this._settle?.(null)
      return
    }
    this._editing = true
    this._draw()
  }

  _abandon(event) {
    const gesture = this._gesture
    if (gesture?.pointerId !== event.pointerId) return
    this._gesture = null
    if (gesture.kind === 'draw') {
      this._rect = null
      this._editing = false
    } else {
      this._rect = gesture.from
    }
    this._draw()
  }

  /** The rectangle boxes must stay inside: the area, or the whole surface. */
  _limits() {
    if (this._area) return this._area
    const { width, height } = this._viewport()
    return { x: 0, y: 0, width, height }
  }

  _inArea(point) {
    const { x, y, width, height } = this._limits()
    return point.x >= x && point.y >= y && point.x <= x + width && point.y <= y + height
  }

  _clampPoint(point) {
    const { x, y, width, height } = this._limits()
    return {
      x: Math.min(Math.max(point.x, x), x + width),
      y: Math.min(Math.max(point.y, y), y + height)
    }
  }

  _clampMove(rect) {
    const { x, y, width, height } = this._limits()
    const w = Math.min(rect.width, width)
    const h = Math.min(rect.height, height)
    return {
      ...rect,
      width: w,
      height: h,
      x: Math.round(Math.min(Math.max(rect.x, x), Math.max(x, x + width - w))),
      y: Math.round(Math.min(Math.max(rect.y, y), Math.max(y, y + height - h)))
    }
  }

  // ---------------------------------------------------------------- drawing

  _draw() {
    const els = this._els
    if (!els) return
    const rect = this._rect
    this._drawBubble()
    if (!isRect(rect)) {
      els.frame.style.display = 'none'
      els.foot.style.display = 'none'
      els.grips.style.display = 'none'
      return
    }

    const viewport = this._viewport()
    // The foot goes under the box, above it when there is no room below, and inside the box's
    // bottom edge when the box fills the display's height.
    const below = rect.y + rect.height + FOOT <= viewport.height
    const above = !below && rect.y - FOOT >= 0
    const place = below ? 'below' : above ? 'above' : 'inside'

    assign(els.frame, {
      display: 'block',
      left: `${rect.x - RING}px`,
      top: `${rect.y - (place === 'above' ? FOOT : RING)}px`,
      width: `${rect.width + RING * 2}px`,
      height: `${rect.height + RING + (place === 'inside' ? RING : FOOT)}px`,
      borderTopWidth: `${place === 'above' ? FOOT : RING}px`,
      borderBottomWidth: `${place === 'below' ? FOOT : RING}px`
    })
    // The bevel spans the whole frame, thick edge included.
    assign(els.bevel, {
      top: `-${place === 'above' ? FOOT : RING}px`,
      bottom: `-${place === 'below' ? FOOT : RING}px`
    })

    const editing = this._editing && !this._gesture
    els.size.textContent = `${rect.width} × ${rect.height}`
    // Within an area (a window), the position counts from its corner.
    const corner = this._area ?? { x: 0, y: 0 }
    els.origin.textContent = `${rect.x - corner.x}, ${rect.y - corner.y}`
    els.actions.style.display = this._editing ? 'flex' : 'none'
    assign(els.grips, {
      display: editing ? 'block' : 'none',
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    })

    const frameLeft = rect.x - RING
    const frameWidth = rect.width + RING * 2
    assign(els.foot, {
      display: 'flex',
      minWidth: `${frameWidth}px`,
      top: `${place === 'below' ? rect.y + rect.height : place === 'above' ? rect.y - FOOT : rect.y + rect.height - FOOT}px`,
      borderRadius:
        place === 'below' ? '0 0 6px 6px' : place === 'above' ? '6px 6px 0 0' : '6px'
    })
    // Wider than the box (a small selection) and out of room on the right: hang it from the
    // box's right edge instead of its left, so it stays attached and on the display.
    const footWidth = Math.max(els.foot.offsetWidth || 0, frameWidth)
    const left =
      frameLeft + footWidth > viewport.width
        ? Math.max(0, frameLeft + frameWidth - footWidth)
        : Math.max(0, frameLeft)
    els.foot.style.left = `${left}px`
  }

  /**
   * The cursor bubble: shown while idle with the pointer on the surface, centred just above the
   * cursor (below it near the top edge), kept inside the surface, and eased toward the cursor so it
   * glides rather than jumps.
   */
  _drawBubble() {
    const els = this._els
    if (!els) return
    const showing = this.idle && this._pointer !== null
    els.hint.style.opacity = showing ? '1' : '0'
    els.hint.style.scale = showing ? '1' : '0.92'
    els.message.textContent = 'Drag to select an area'
    if (!showing) return
    if (!this._frame) this._frame = nextFrame(() => this._stepBubble())
  }

  _bubbleTarget() {
    const { width, height } = this._viewport()
    const box = this._els.hint
    const w = box.offsetWidth || 0
    const h = box.offsetHeight || 0
    const { x, y } = this._pointer
    const below = y - BUBBLE_GAP - h < 4
    return {
      x: Math.min(Math.max(x - w / 2, 4), Math.max(4, width - w - 4)),
      y: Math.min(below ? y + BUBBLE_GAP + 12 : y - BUBBLE_GAP - h, Math.max(4, height - h - 4))
    }
  }

  _stepBubble() {
    this._frame = 0
    const els = this._els
    if (!els || !this._pointer || !this.idle) return
    const target = this._bubbleTarget()
    const from = this._bubble ?? target
    const next = {
      x: from.x + (target.x - from.x) * BUBBLE_EASE,
      y: from.y + (target.y - from.y) * BUBBLE_EASE
    }
    const settled = Math.abs(target.x - next.x) < 0.3 && Math.abs(target.y - next.y) < 0.3
    this._bubble = settled ? target : next
    els.hint.style.transform = `translate3d(${this._bubble.x}px, ${this._bubble.y}px, 0)`
    if (!settled) this._frame = nextFrame(() => this._stepBubble())
  }

  _render() {
    const theme = THEMES[this._theme ?? systemTheme()] ?? THEMES.dark
    const container = assign(document.createElement('div'), {
      position: 'fixed',
      inset: '0',
      backgroundColor: 'transparent',
      zIndex: String(Z_INDEX_OVERLAY),
      cursor: 'crosshair',
      touchAction: 'none',
      userSelect: 'none',
      webkitUserSelect: 'none'
    })
    container.dataset.kimochiRegionSelect = 'true'

    // The picture: everything dimmed, and the image of what is being edited at its own place.
    let shade = null
    let stage = null
    if (this._picture) {
      shade = assign(document.createElement('div'), {
        position: 'absolute',
        inset: '0',
        backgroundColor: 'rgba(0, 0, 0, 0.62)',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity 200ms ease-out'
      })
      const { x, y, width, height } = this._picture
      stage = assign(document.createElement('div'), {
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
        overflow: 'hidden',
        borderRadius: '10px',
        backgroundColor: 'rgba(0, 0, 0, 0.35)',
        boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.14), 0 24px 64px rgba(0, 0, 0, 0.55)',
        pointerEvents: 'none',
        opacity: '0',
        transform: 'scale(0.985)',
        transition: 'opacity 220ms ease-out, transform 260ms cubic-bezier(0.16, 1, 0.3, 1)'
      })
      nextFrame(() =>
        nextFrame(() => {
          shade.style.opacity = '1'
          stage.style.opacity = '1'
          stage.style.transform = 'none'
        })
      )
    }

    // The ring: the box's border, drawn outside the selected area. Its inner 1px line is the
    // shadow side of a raised edge; the bevel child carries the lit top and shaded bottom.
    const frame = assign(document.createElement('div'), {
      position: 'absolute',
      display: 'none',
      boxSizing: 'border-box',
      border: `${RING}px solid ${theme.accent}`,
      borderRadius: '6px',
      backgroundColor: theme.tint,
      backgroundClip: 'padding-box',
      boxShadow: `inset 0 0 0 1px ${theme.shade}, ${theme.lift}`,
      pointerEvents: 'none'
    })
    const bevel = assign(document.createElement('div'), {
      position: 'absolute',
      left: `-${RING}px`,
      right: `-${RING}px`,
      borderRadius: '6px',
      boxShadow: `inset 0 1px 0 ${theme.highlight}, inset 0 -1px 0 ${theme.shade}`,
      pointerEvents: 'none'
    })
    frame.append(bevel)

    // Resize handles at the corners and edge midpoints, on a layer of their own over the box so
    // the foot cannot cover the ones on the edge it borders.
    const grips = assign(document.createElement('div'), {
      position: 'absolute',
      display: 'none',
      pointerEvents: 'none'
    })
    const handles = []
    for (const [x, y] of [
      [0, 0],
      [50, 0],
      [100, 0],
      [0, 50],
      [100, 50],
      [0, 100],
      [50, 100],
      [100, 100]
    ]) {
      const handle = assign(document.createElement('div'), {
        position: 'absolute',
        left: `calc(${x}% - 5px)`,
        top: `calc(${y}% - 5px)`,
        width: '10px',
        height: '10px',
        boxSizing: 'border-box',
        borderRadius: '3px',
        backgroundColor: '#fff',
        border: `2px solid ${theme.accent}`,
        boxShadow: `0 1px 2px ${theme.shade}`,
        pointerEvents: 'none'
      })
      handles.push(handle)
      grips.append(handle)
    }

    // The foot: the frame's thick edge, holding the readout and the controls.
    const foot = assign(document.createElement('div'), {
      position: 'absolute',
      display: 'none',
      alignItems: 'center',
      gap: '10px',
      boxSizing: 'border-box',
      height: `${FOOT}px`,
      padding: `0 ${RING + 4}px`,
      backgroundColor: theme.accent,
      boxShadow: `inset 0 -1px 0 ${theme.shade}, ${theme.lift}`,
      color: '#fff',
      font: `500 11px/1 ${MONO}`,
      whiteSpace: 'nowrap',
      cursor: 'move'
    })
    const size = assign(document.createElement('span'), { fontWeight: '600' })
    const origin = assign(document.createElement('span'), { opacity: '0.7' })
    const spacer = assign(document.createElement('span'), { flex: '1' })
    const actions = assign(document.createElement('span'), {
      display: 'none',
      alignItems: 'center',
      gap: '4px',
      marginLeft: '6px'
    })
    // `style`: primary (filled white), outline (the alternate confirm) or quiet (Esc).
    const button = (label, style, onPress) => {
      const element = assign(document.createElement('button'), {
        height: '20px',
        padding: '0 8px',
        border: '0',
        borderRadius: '4px',
        font: `600 11px/1 ${UI}`,
        color: style === 'primary' ? theme.accent : '#fff',
        backgroundColor:
          style === 'primary' ? '#fff' : style === 'outline' ? 'transparent' : 'rgba(255, 255, 255, 0.16)',
        boxShadow:
          style === 'primary'
            ? `0 1px 0 ${theme.shade}`
            : style === 'outline'
              ? 'inset 0 0 0 1px rgba(255, 255, 255, 0.7)'
              : 'none',
        cursor: 'pointer'
      })
      element.type = 'button'
      element.textContent = label
      // Presses on a control are not the start of a drag.
      element.addEventListener('pointerdown', (event) => event.stopPropagation())
      element.addEventListener('click', (event) => {
        event.stopPropagation()
        onPress()
      })
      return element
    }
    actions.append(
      button('Esc', 'quiet', () => this.cancel()),
      ...(this._alternateLabel ? [button(this._alternateLabel, 'outline', () => this.confirm('alternate'))] : []),
      button(`${this._confirmLabel} ⏎`, 'primary', () => this.confirm())
    )
    foot.append(size, origin, spacer, actions)
    foot.addEventListener('pointerdown', (event) => this._beginMove(event))

    // The cursor bubble. Positioned by transform from the top-left; fades and scales in place.
    const hint = assign(document.createElement('div'), {
      position: 'fixed',
      left: '0',
      top: '0',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 9px 6px 11px',
      borderRadius: '8px',
      backgroundColor: theme.hint,
      color: theme.hintText,
      boxShadow: `0 0 0 1px ${theme.hintEdge}, ${theme.lift}`,
      font: `500 12px/16px ${UI}`,
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      opacity: '0',
      scale: '0.92',
      transformOrigin: '50% 100%',
      transition: 'opacity 140ms ease-out, scale 180ms cubic-bezier(0.16, 1, 0.3, 1)',
      willChange: 'transform'
    })
    const message = document.createElement('span')
    const divider = assign(document.createElement('span'), {
      width: '1px',
      height: '12px',
      margin: '0 3px',
      backgroundColor: theme.hintEdge
    })
    // Escape drawn as a key cap: a raised face with a heavier bottom edge.
    const key = assign(document.createElement('kbd'), {
      display: 'inline-flex',
      alignItems: 'center',
      height: '18px',
      padding: '0 5px',
      boxSizing: 'border-box',
      borderRadius: '4px',
      backgroundColor: theme.keyBg,
      boxShadow: `inset 0 0 0 1px ${theme.keyEdge}, inset 0 -1.5px 0 ${theme.keyEdge}`,
      font: `600 10px/1 ${UI}`,
      letterSpacing: '0.02em'
    })
    key.textContent = 'esc'
    const cancel = assign(document.createElement('span'), { opacity: '0.7' })
    cancel.textContent = 'to cancel'
    hint.append(message, divider, key, cancel)

    if (shade) container.append(shade, stage)
    container.append(frame, foot, grips, hint)
    ;(this._mount ?? document.body).append(container)
    this._container = container
    this._els = { frame, bevel, foot, size, origin, actions, grips, hint, message, stage }
    this._drawBubble()
  }

  _publishHitRects() {
    this._onHitRects?.(this.hitRects)
  }

  _teardown() {
    for (const detach of this._detach.splice(0)) detach()
    this._gesture = null
    this._editing = false
    this._rect = null
    cancelFrame(this._frame)
    this._frame = 0
    this._pointer = null
    this._bubble = null
    this._pictureUrl = null
    this._pristine = false
    this._container?.remove()
    this._container = null
    this._els = null
    // Publish the empty set before forgetting the bounds, so the caller can restore click-through.
    this._publishHitRects()
    this._bounds = null
  }
}

/**
 * One-shot editor run, in either call shape.
 *
 * Given an element: mounts into it and resolves with `{x, y, width, height}` in this window's CSS
 * pixels, or null. It never rejects and never stays pending — a caller holding a full-display hit
 * region for the duration can release it in a `finally` without risk of the overlay swallowing
 * every click.
 *
 * Given options with `bounds`: resolves with `{local, desktop, bounds}`, or null.
 *
 * @param {HTMLElement | {bounds?: object, container?: HTMLElement, signal?: AbortSignal,
 *   onHitRects?: Function, cancelOnMisclick?: boolean, confirmLabel?: string,
 *   theme?: 'light'|'dark'}} target
 * @param {{confirmLabel?: string, theme?: 'light'|'dark', signal?: AbortSignal}} [options]
 *   Extra options for the element form.
 */
export async function selectRegion(target = {}, options = {}) {
  const element = typeof target === 'object' && 'nodeType' in target ? target : null
  const settings = element ? { ...options, container: element } : target
  const selector = new RegionSelect(settings)
  try {
    const result = await selector.start(settings)
    if (!element) return result
    return result ? result.local : null
  } catch (error) {
    // The element form promises never to reject: a caller releasing its hit region in a `finally`
    // must not have to guard against a throw here.
    if (!element) throw error
    console.error('[region-select] selection failed:', error)
    return null
  } finally {
    selector.destroy()
  }
}

export default { RegionSelect, selectRegion, MINIMUM_DRAG }
