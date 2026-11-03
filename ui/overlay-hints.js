/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The overlay's hint bar: a pill along the bottom of the overlay that says what Shift does, shown
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
  const hint = (key, rest) => {
    const item = make('span', 'overlay-hint')
    item.append(make('kbd', 'overlay-hint-key', key), document.createTextNode(` ${rest}`))
    return item
  }
  const key = shiftKey()
  bar.append(
    hint(key, '+ point at a word to look it up'),
    hint(key, '+ click or drag text and the card'),
    make('span', 'overlay-hint overlay-hint-quiet', 'Without Shift, clicks go to the game')
  )
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

  return {
    /** Show the bar or not; whether it is shown. */
    sync(shown) {
      if (bar.hidden === !shown) return shown
      bar.hidden = !shown
      if (!shown) close.removeAttribute('data-hover')
      return shown
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
