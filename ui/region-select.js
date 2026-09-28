/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Screen-region selection for "Select Region" on a screen source — Electron's select-and-scan.
 *
 * This is a port of `src/renderer/src/components/SelectScanOverlay.tsx`: the same transparent
 * crosshair surface, the same blue selection rectangle, the same bottom instruction pill, the same
 * 10-unit minimum drag, and the same Escape-cancels behaviour. It is a DOM helper with no framework
 * and no backend calls — it returns a rectangle and nothing else. The caller (the overlay) owns
 * committing the crop and triggering the scan that follows.
 *
 * ## Coordinates — deliberately unlike the Electron original
 *
 * The Electron overlay sat in a display's *work area*, so it added a menu-bar offset and guessed at
 * full-screen dimensions. This overlay covers the full native display bounds, so there is no menu
 * bar to compensate for and that adjustment is intentionally NOT ported — carrying it over would
 * shift every selection down by the menu bar's height.
 *
 * Everything here is in points, never pixels: CSS points inside the window, desktop points outside.
 * There is no `devicePixelRatio` anywhere in this file. Converting points to capture pixels needs
 * the source's full capture dimensions, which only the caller knows, so the caller does it:
 *
 *     const { local } = await selectRegion({ bounds })       // display bounds, desktop points
 *     const scaleX = fullWidthPx / bounds.width              // from the native source catalog
 *     const scaleY = fullHeightPx / bounds.height
 *     crop = { x: local.x * scaleX, y: local.y * scaleY, ... , reference_width: fullWidthPx, ... }
 *
 * ## Two call shapes
 *
 * `selectRegion()` accepts either form, so a caller can take only what it needs:
 *
 *     await selectRegion(container)    // -> {x, y, width, height} in this window's CSS pixels, or
 *                                      //    null. Mounts into `container`. Never rejects.
 *     await selectRegion({ bounds })   // -> {local, desktop, bounds}, or null. `bounds` is the
 *                                      //    display in desktop points, so `desktop` is filled in.
 *
 * ## Click-through
 *
 * The overlay is click-through except where it publishes interactive rectangles to the native side,
 * so without a full-surface hit region a mousedown never arrives. A caller that publishes its own
 * region needs nothing here. A caller that would rather this module drive it can pass `onHitRects`
 * with the bounds form; `hitRects` is then the full display rectangle in DESKTOP points, the same
 * space the native cursor hit test uses, and empty once the run ends:
 *
 *     const selector = new RegionSelect({ onHitRects: (rects) => invoke('regions', { rects }) })
 *     const result = await selector.start({ bounds })
 *
 * ## A misclick does not cancel
 *
 * As in the Electron component, a drag under the minimum clears the rectangle and leaves the
 * surface up for another attempt rather than resolving — a stray click should not abandon a scan
 * the user asked for. Escape always settles. Pass `cancelOnMisclick: true` for the other behaviour.
 *
 * There is no dimmed backdrop: the original's surface is fully transparent, so nothing can ever
 * cover the rectangle being drawn. Adding a dim would be a visual change, not a port.
 */

/** Matches `Z_INDEX_SELECT_SCAN_OVERLAY` / `_CONTROLS` in the Electron build. */
const Z_INDEX_OVERLAY = 6000
const Z_INDEX_CONTROLS = 6001

/** A drag smaller than this in either axis is discarded, as in the original. */
const MINIMUM_DRAG = 10

const INSTRUCTIONS = 'Click and drag to select a region to scan. Press '

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

/**
 * One selection surface. A single instance may be started repeatedly; only one run is active at a
 * time, and starting again cancels the previous run rather than stacking surfaces.
 */
export class RegionSelect {
  /** @param {{onHitRects?: (rects: {x:number,y:number,width:number,height:number}[]) => void}} options */
  constructor({ onHitRects, container, cancelOnMisclick = false } = {}) {
    this._onHitRects = onHitRects
    this._mount = container ?? null
    this._cancelOnMisclick = cancelOnMisclick
    this._bounds = null
    this._container = null
    this._selection = null
    this._drag = null
    this._settle = null
    this._detach = []
  }

  /** True while a selection surface is on screen. */
  get active() {
    return this._container !== null
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
   * Runs a selection.
   *
   * @param {{bounds: {x:number,y:number,width:number,height:number}, signal?: AbortSignal}} options
   *   `bounds` is the display this overlay covers, in desktop points.
   * @returns {Promise<{local: object, desktop: object, bounds: object} | null>} the selected
   *   rectangle in overlay-local points and in desktop points, or null if the user cancelled.
   */
  start({ bounds, signal, container } = {}) {
    if (bounds !== undefined && !isRect(bounds)) {
      return Promise.reject(new Error('Region selection needs the display bounds it covers.'))
    }
    if (container) this._mount = container
    // A second start supersedes the first; the earlier caller is told it was cancelled.
    this.cancel()

    this._bounds = bounds ? { ...bounds } : null
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

      this._listen(document, 'keydown', (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        this._settle?.(null)
      })

      this._listen(this._container, 'pointerdown', (event) => this._begin(event))
      this._listen(this._container, 'pointermove', (event) => this._update(event))
      this._listen(this._container, 'pointerup', (event) => this._finish(event))
      this._listen(this._container, 'pointercancel', (event) => this._abandon(event))
      this._listen(this._container, 'lostpointercapture', (event) => this._abandon(event))
    })
  }

  /** Cancels a running selection; its promise resolves with null. Safe to call when inactive. */
  cancel() {
    this._settle?.(null)
  }

  /** Removes everything this instance put in the document. Safe to call more than once. */
  destroy() {
    this.cancel()
    this._teardown()
  }

  // ---------------------------------------------------------------- internals

  _listen(target, type, handler, options) {
    target.addEventListener(type, handler, options)
    this._detach.push(() => target.removeEventListener(type, handler, options))
  }

  _point(event) {
    // The surface covers the window exactly, so client coordinates are overlay-local points.
    const rect = this._container.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  _begin(event) {
    if (event.button !== 0 || this._drag) return
    event.preventDefault()
    this._container.setPointerCapture(event.pointerId)
    this._drag = { start: this._point(event), pointerId: event.pointerId }
    this._draw(null)
  }

  _update(event) {
    if (this._drag?.pointerId !== event.pointerId) return
    this._draw(rectangleFrom(this._drag.start, this._point(event)))
  }

  _finish(event) {
    if (this._drag?.pointerId !== event.pointerId) return
    const { start } = this._drag
    this._drag = null
    if (this._container.hasPointerCapture(event.pointerId)) {
      this._container.releasePointerCapture(event.pointerId)
    }

    const local = rectangleFrom(start, this._point(event))
    // As in the original: too small is a misclick, so it clears and selection stays open rather
    // than committing a tiny region or closing on the user.
    if (local.width < MINIMUM_DRAG || local.height < MINIMUM_DRAG) {
      this._draw(null)
      if (this._cancelOnMisclick) this._settle?.(null)
      return
    }

    this._settle?.(
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

  _abandon(event) {
    if (this._drag?.pointerId !== event.pointerId) return
    this._drag = null
    this._draw(null)
  }

  _draw(rect) {
    if (!this._selection) return
    if (!isRect(rect)) {
      this._selection.style.display = 'none'
      return
    }
    assign(this._selection, {
      display: 'block',
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    })
  }

  _render() {
    // Styles are the Electron component's, verbatim.
    const container = assign(document.createElement('div'), {
      position: 'fixed',
      inset: '0',
      backgroundColor: 'transparent',
      zIndex: String(Z_INDEX_OVERLAY),
      cursor: 'crosshair',
      touchAction: 'none'
    })
    container.dataset.kimochiRegionSelect = 'true'

    const selection = assign(document.createElement('div'), {
      position: 'absolute',
      display: 'none',
      border: '2px solid #4dabf7',
      backgroundColor: 'rgba(77, 171, 247, 0.15)',
      boxSizing: 'border-box',
      pointerEvents: 'none'
    })

    const instructions = assign(document.createElement('div'), {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      color: '#fff',
      padding: '12px 24px',
      borderRadius: '8px',
      fontSize: '14px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      pointerEvents: 'none',
      zIndex: String(Z_INDEX_CONTROLS)
    })
    const strong = document.createElement('strong')
    strong.textContent = 'Esc'
    instructions.append(INSTRUCTIONS, strong, ' to cancel.')

    container.append(selection, instructions)
    ;(this._mount ?? document.body).append(container)
    this._container = container
    this._selection = selection
  }

  _publishHitRects() {
    this._onHitRects?.(this.hitRects)
  }

  _teardown() {
    for (const detach of this._detach.splice(0)) detach()
    this._drag = null
    this._container?.remove()
    this._container = null
    this._selection = null
    // Publish the empty set before forgetting the bounds, so the caller can restore click-through.
    this._publishHitRects()
    this._bounds = null
  }
}

/**
 * One-shot selection, in either call shape.
 *
 * Given an element: mounts into it and resolves with `{x, y, width, height}` in this window's CSS
 * pixels, or null. It never rejects and never stays pending — a caller holding a full-display hit
 * region for the duration can release it in a `finally` without risk of the overlay swallowing
 * every click.
 *
 * Given options with `bounds`: resolves with `{local, desktop, bounds}`, or null.
 *
 * @param {HTMLElement | {bounds?: object, container?: HTMLElement, signal?: AbortSignal,
 *   onHitRects?: Function, cancelOnMisclick?: boolean}} target
 */
export async function selectRegion(target = {}) {
  const element = typeof target === 'object' && 'nodeType' in target ? target : null
  const options = element ? { container: element } : target
  const selector = new RegionSelect(options)
  try {
    const result = await selector.start(options)
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
