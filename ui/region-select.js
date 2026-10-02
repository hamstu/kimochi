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
 * The frame sits *outside* the selected area, so it never covers what is being chosen.
 *
 * ## Coordinates
 *
 * Everything here is in points, never pixels: CSS points inside the window, desktop points outside.
 * There is no `devicePixelRatio` anywhere in this file; converting points to capture pixels needs
 * the display's backing scale, which only the caller knows.
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

/** A drawn box smaller than this in either axis is a misclick, not a selection. */
const MINIMUM_DRAG = 10

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
    hint: 'rgba(24, 25, 27, 0.92)',
    hintText: '#edeef0'
  },
  light: {
    accent: '#3e63dd',
    tint: 'rgba(62, 99, 221, 0.08)',
    lift: '0 10px 28px rgba(0, 0, 0, 0.22)',
    highlight: 'rgba(255, 255, 255, 0.5)',
    shade: 'rgba(0, 0, 0, 0.3)',
    hint: 'rgba(255, 255, 255, 0.95)',
    hintText: '#1c2024'
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
   *   confirmLabel?: string, theme?: 'light' | 'dark'}} options
   */
  constructor({
    onHitRects,
    container,
    cancelOnMisclick = false,
    confirmLabel = 'Confirm',
    theme
  } = {}) {
    this._onHitRects = onHitRects
    this._mount = container ?? null
    this._cancelOnMisclick = cancelOnMisclick
    this._confirmLabel = confirmLabel
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
    this._render()
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

  /** Commits the current box, if there is one worth committing. */
  confirm() {
    if (!this._settle || !this._editing || !bigEnough(this._rect)) return
    const local = { ...this._rect }
    this._settle(
      this._bounds
        ? {
            local,
            desktop: {
              x: local.x + this._bounds.x,
              y: local.y + this._bounds.y,
              width: local.width,
              height: local.height
            },
            bounds: { ...this._bounds }
          }
        : { local, desktop: null, bounds: null }
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
    if (event.key === 'Escape') {
      event.preventDefault()
      this._settle?.(null)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      this.confirm()
    } else if (this._editing && !this._gesture && event.key.startsWith('Arrow')) {
      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      this._rect = this._clampMove({ ...this._rect, x: this._rect.x + dx, y: this._rect.y + dy })
      this._draw()
    }
  }

  _begin(event) {
    if (event.button !== 0 || this._gesture) return
    event.preventDefault()
    const point = this._point(event)
    const zone = this._editing ? zoneOf(point, this._rect) : 'outside'
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
    if (!gesture) {
      if (this._editing) {
        this._container.style.cursor = CURSORS[zoneOf(this._point(event), this._rect)]
      }
      return
    }
    if (gesture.pointerId !== event.pointerId) return
    const point = this._clampPoint(this._point(event))
    if (gesture.kind === 'draw') {
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
    // Too small is a misclick: clear it and stay open for another attempt rather than leaving a
    // sliver to confirm.
    if (!bigEnough(this._rect)) {
      this._rect = null
      this._editing = false
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

  _clampPoint(point) {
    const { width, height } = this._viewport()
    return {
      x: Math.min(Math.max(point.x, 0), width),
      y: Math.min(Math.max(point.y, 0), height)
    }
  }

  _clampMove(rect) {
    const { width, height } = this._viewport()
    return {
      ...rect,
      x: Math.round(Math.min(Math.max(rect.x, 0), Math.max(0, width - rect.width))),
      y: Math.round(Math.min(Math.max(rect.y, 0), Math.max(0, height - rect.height)))
    }
  }

  // ---------------------------------------------------------------- drawing

  _draw() {
    const els = this._els
    if (!els) return
    const rect = this._rect
    els.hint.style.display = rect || this._gesture ? 'none' : 'block'
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
    els.origin.textContent = `${rect.x}, ${rect.y}`
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
    const button = (label, primary, onPress) => {
      const element = assign(document.createElement('button'), {
        height: '20px',
        padding: '0 8px',
        border: '0',
        borderRadius: '4px',
        font: `600 11px/1 ${UI}`,
        color: primary ? theme.accent : '#fff',
        backgroundColor: primary ? '#fff' : 'rgba(255, 255, 255, 0.16)',
        boxShadow: primary ? `0 1px 0 ${theme.shade}` : 'none',
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
      button('Esc', false, () => this.cancel()),
      button(`${this._confirmLabel} ⏎`, true, () => this.confirm())
    )
    foot.append(size, origin, spacer, actions)
    foot.addEventListener('pointerdown', (event) => this._beginMove(event))

    const hint = assign(document.createElement('div'), {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 14px',
      borderRadius: '8px',
      backgroundColor: theme.hint,
      color: theme.hintText,
      boxShadow: theme.lift,
      font: `500 12px/1.2 ${UI}`,
      pointerEvents: 'none'
    })
    hint.append('Drag to select an area · ')
    const key = assign(document.createElement('span'), { font: `600 11px ${MONO}` })
    key.textContent = 'Esc'
    hint.append(key, ' to cancel')

    container.append(frame, foot, grips, hint)
    ;(this._mount ?? document.body).append(container)
    this._container = container
    this._els = { frame, bevel, foot, size, origin, actions, grips, hint }
  }

  _publishHitRects() {
    this._onHitRects?.(this.hitRects)
  }

  _teardown() {
    for (const detach of this._detach.splice(0)) detach()
    this._gesture = null
    this._editing = false
    this._rect = null
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
