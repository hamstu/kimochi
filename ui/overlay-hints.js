/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The overlay's hint bar: a pill under the scan area (or along the bottom of the overlay for a
 * full-screen source) that says what Shift does, shown
 * while there is text on the overlay until the reader closes it (`overlayHintsDismissed`;
 * Settings → General → Overlay hints shows it again).
 *
 * The words and the Text Hooker's card let clicks through to the game unless Shift is held
 * (`shift` regions, `View::live_regions` in native), which nothing on screen would otherwise tell
 * anyone. The bar itself lets every click through except on its ×, which takes the mouse with or
 * without Shift: a reader closing the hint has not learned it yet.
 *
 * The overlay never has the pointer, so the × lights from `pointer(x, y)` (`data-hover`), as the
 * hook card's controls do.
 */

export const HINTS_DISMISSED = 'overlayHintsDismissed'

const make = (tag, className, text) => {
  const element = document.createElement(tag)
  element.className = className
  if (text) element.textContent = text
  return element
}

/** The Shift key as this platform's keyboards label it. */
function shiftKey() {
  return window.__KIMOCHI_PLATFORM__?.os === 'macos' ? '⇧ Shift' : 'Shift'
}

/**
 * @param {HTMLElement} parent
 * @param {{ onDismiss: () => void }} hooks
 */
export function createOverlayHints(parent, hooks) {
  const bar = make('div', 'overlay-hints')
  bar.hidden = true
  bar.setAttribute('role', 'note')
  // Kimochi's own words, never looked up (host/frontend-mode.js).
  bar.setAttribute('data-no-scan', '')
  // One line: Hold [Shift] to … (what Shift does depends on click-through, `sync`).
  const line = make('span', 'overlay-hint')
  const rest = document.createTextNode('')
  line.append(document.createTextNode('Hold '), make('kbd', 'overlay-hint-key', shiftKey()), rest)
  bar.append(line)
  const close = make('button', 'overlay-hints-close')
  close.type = 'button'
  close.setAttribute('aria-label', 'Hide these hints')
  close.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
  close.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    bar.hidden = true
    hooks.onDismiss()
  })
  bar.append(close)
  parent.append(bar)

  let gatedNow = null
  return {
    /**
     * Show the bar or not; whether it is shown. `gated`: clicks on text go to the game unless
     * Shift is held (`overlayClickThrough`), so Shift is what makes text clickable too.
     */
    sync(shown, gated = true) {
      if (gated !== gatedNow) {
        gatedNow = gated
        rest.textContent = gated ? ' to look up words and click text' : ' over a word to look it up'
      }
      if (bar.hidden === !shown) return shown
      bar.hidden = !shown
      if (!shown) close.removeAttribute('data-hover')
      return shown
    },
    /**
     * Put the bar under `area` (overlay coordinates: the scan area), centred, or inside its bottom
     * edge where there is no room below; with null, at the bottom of the overlay.
     */
    place(area) {
      if (bar.hidden) return
      if (!area) {
        bar.style.removeProperty('left')
        bar.style.removeProperty('top')
        bar.style.removeProperty('bottom')
        return
      }
      const width = bar.offsetWidth
      const height = bar.offsetHeight
      const margin = 8
      const below = area.y + area.height + 10
      const top =
        below + height + margin <= innerHeight
          ? below
          : Math.max(margin, Math.min(innerHeight - height - margin, area.y + area.height - height - 12))
      const centre = Math.max(width / 2 + margin, Math.min(innerWidth - width / 2 - margin, area.x + area.width / 2))
      bar.style.left = `${Math.round(centre)}px`
      bar.style.top = `${Math.round(top)}px`
      bar.style.bottom = 'auto'
    },
    /** The pointer in overlay coordinates: lights the × under it. */
    pointer(x, y) {
      if (bar.hidden) return
      const r = close.getBoundingClientRect()
      close.toggleAttribute('data-hover', x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
    },
    /** The × while the bar is shown (overlay coordinates), the one place that takes the mouse. */
    rects: () => (bar.hidden ? [] : [close.getBoundingClientRect()]),
    element: bar
  }
}
