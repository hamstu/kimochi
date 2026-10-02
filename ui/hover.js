/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Showing the user what is about to be scanned.
 *
 * A port of src/renderer/src/components/SourceHoverOverlay.tsx: hovering the
 * controller's source button outlines the captured window in blue, and hovering
 * Select Region outlines the saved crop in green. Both are passive markings —
 * never interactive, never part of the click-through hit regions — so they can
 * sit over the source without getting in the way.
 *
 * Coordinates follow the same rule as the text overlay: the crop is stored
 * against the reference capture it was drawn on, so it is scaled per axis by the
 * current source bounds rather than by a single factor.
 */

/** A capture this recent is reused for the same source rather than taken again. */
export const HOVER_PREVIEW_REUSE_MS = 2000

/**
 * One capture per hover, never more.
 *
 * `start()` asks for a picture of the hovered window; `stop()` forgets it. Each
 * start bumps a generation, so a capture that lands after its hover has ended —
 * or after a newer hover began — is dropped instead of shown. A picture of the
 * same source taken under `HOVER_PREVIEW_REUSE_MS` ago is reused, so brushing the
 * pointer across the source picker does not capture on every pass.
 *
 * `capture()` resolves to `{key, url}` (key: the source id) or null, and may
 * reject; either way the outline is unaffected — no picture is the fallback.
 *
 * The last picture of each source is kept: `capture` calls `show(key)` as soon
 * as it knows the source, so the outline gets the last picture at once and the
 * new one replaces it when it lands, instead of waiting through every capture.
 * A url that is replaced is handed to `release` (an object url to revoke).
 */
export class HoverPreview {
  constructor({
    capture,
    onChange,
    release,
    now = () => Date.now(),
    reuseMs = HOVER_PREVIEW_REUSE_MS
  }) {
    this.capture = capture
    this.onChange = onChange
    this.release = release
    this.now = now
    this.reuseMs = reuseMs
    this.generation = 0
    this.url = null
    this.cached = null
  }

  async start() {
    const generation = ++this.generation
    this.setUrl(null)
    let result = null
    try {
      result = await this.capture({
        reusable: (key) =>
          this.cached?.key === key && this.now() - this.cached.at < this.reuseMs
            ? this.cached.url
            : null,
        show: (key) => {
          if (generation === this.generation && this.cached?.key === key) {
            this.setUrl(this.cached.url)
          }
        }
      })
    } catch {
      result = null
    }
    if (generation !== this.generation || !result?.url) return
    if (!result.reused) {
      const previous = this.cached?.url
      this.cached = { key: result.key, url: result.url, at: this.now() }
      this.setUrl(result.url)
      // After the switch, so the outline never holds a released url.
      if (previous && previous !== result.url) this.release?.(previous)
      return
    }
    this.setUrl(result.url)
  }

  stop() {
    this.generation++
    this.setUrl(null)
  }

  setUrl(url) {
    if (this.url === url) return
    this.url = url
    this.onChange?.()
  }
}

export class HoverOverlay {
  constructor(container) {
    this.container = container
    this.windowImage = null
    this.windowOutline = null
    this.cropOutline = null
  }

  element(className) {
    const element = document.createElement('div')
    element.className = className
    this.container.append(element)
    return element
  }

  /** Removes the markings. Ones dissipating (see `dissipate`) finish on their own. */
  clear() {
    for (const element of [this.windowImage, this.windowOutline, this.cropOutline]) element?.remove()
    for (const element of this.container.querySelectorAll('.hover-window-image.leaving')) {
      element.remove()
    }
    this.windowImage = null
    this.windowOutline = null
    this.cropOutline = null
  }

  /**
   * Let the window's markings go at once with a quick zoom, blur and fade about
   * the window's centre — what bringing the window to the front looks like —
   * rather than snapping off. The next `update` starts afresh.
   */
  dissipate() {
    const leaving = [this.windowImage, this.windowOutline, this.cropOutline].filter(Boolean)
    this.windowImage = null
    this.windowOutline = null
    this.cropOutline = null
    for (const element of leaving) {
      element.classList.add('dissipate')
      const done = () => element.remove()
      element.addEventListener('animationend', done, { once: true })
      // In case the animation never runs (a hidden window): never leave one behind.
      setTimeout(done, 600)
    }
  }

  /**
   * @param {{visible: boolean, showWindowOutline: boolean, showCropRegion: boolean,
   *          windowImage?: string|null, bounds: object|null, crop: object|null,
   *          origin: object|null}} view
   */
  update(view) {
    const { visible, showWindowOutline, showCropRegion, windowImage, bounds, crop, origin } = view
    if (!visible || !bounds || !origin) {
      this.clear()
      return
    }

    const left = bounds.x - origin.x
    const top = bounds.y - origin.y

    const outlined = showWindowOutline && bounds.width > 0 && bounds.height > 0
    this.updateWindowImage(outlined ? windowImage : null, left, top, bounds)

    if (outlined) {
      this.windowOutline ??= this.element('hover-window')
      place(this.windowOutline, left, top, bounds.width, bounds.height)
    } else if (this.windowOutline) {
      this.windowOutline.remove()
      this.windowOutline = null
    }

    if (showCropRegion) {
      this.cropOutline ??= this.element('hover-crop')
      // No crop saved means the whole source is the scan area.
      if (crop && crop.reference_width > 0 && crop.reference_height > 0) {
        const sx = bounds.width / crop.reference_width
        const sy = bounds.height / crop.reference_height
        place(this.cropOutline, left + crop.x * sx, top + crop.y * sy, crop.width * sx, crop.height * sy)
      } else {
        place(this.cropOutline, left, top, bounds.width, bounds.height)
      }
    } else if (this.cropOutline) {
      this.cropOutline.remove()
      this.cropOutline = null
    }
  }

  /**
   * The window's own pixels, exactly where the window is.
   *
   * The capture is the window's content rect at its backing scale, so drawing it
   * at the window's bounds in CSS points — the same box the outline surrounds —
   * maps it 1:1 onto the screen, Retina included. It sits beneath the outline
   * (inserted first) and fades in only once decoded, so the outline never waits.
   */
  updateWindowImage(url, left, top, bounds) {
    if (!url) {
      this.windowImage?.remove()
      for (const element of this.container.querySelectorAll('.hover-window-image.leaving')) {
        element.remove()
      }
      this.windowImage = null
      return
    }
    if (this.windowImage?.dataset.src !== url) {
      // The previous picture stays underneath until the new one has loaded, so a fresher
      // picture replaces an older one without a blank frame between them.
      const previous = this.windowImage
      previous?.classList.add('leaving')
      const image = document.createElement('img')
      image.className = 'hover-window-image'
      image.alt = ''
      image.decoding = 'async'
      image.draggable = false
      image.dataset.src = url
      image.addEventListener(
        'load',
        () => {
          // A replaced or removed image may still finish loading; ignore it.
          if (this.windowImage !== image) return
          image.classList.add('loaded')
          setTimeout(() => previous?.remove(), 200)
        },
        { once: true }
      )
      image.src = url
      if (previous?.isConnected) previous.after(image)
      else this.container.prepend(image)
      this.windowImage = image
    }
    for (const image of this.container.querySelectorAll('.hover-window-image')) {
      Object.assign(image.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`
      })
    }
  }
}

/** The 3px inset keeps the border outside the region rather than over its content. */
function place(element, x, y, width, height) {
  Object.assign(element.style, {
    left: `${x - 3}px`,
    top: `${y - 3}px`,
    width: `${width + 6}px`,
    height: `${height + 6}px`
  })
}
