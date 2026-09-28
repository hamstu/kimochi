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

export class HoverOverlay {
  constructor(container) {
    this.container = container
    this.windowOutline = null
    this.cropOutline = null
  }

  element(className) {
    const element = document.createElement('div')
    element.className = className
    this.container.append(element)
    return element
  }

  clear() {
    this.container.replaceChildren()
    this.windowOutline = null
    this.cropOutline = null
  }

  /**
   * @param {{visible: boolean, showWindowOutline: boolean, showCropRegion: boolean,
   *          bounds: object|null, crop: object|null, origin: object|null}} view
   */
  update(view) {
    const { visible, showWindowOutline, showCropRegion, bounds, crop, origin } = view
    if (!visible || !bounds || !origin) {
      this.clear()
      return
    }

    const left = bounds.x - origin.x
    const top = bounds.y - origin.y

    if (showWindowOutline && bounds.width > 0 && bounds.height > 0) {
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
