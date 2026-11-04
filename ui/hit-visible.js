/**
 * Whether a drawn word counts as shown when the overlay asks for the mouse (`render.js`
 * `hitRects`). Its own entrance (`ocr-appear`, overlay-text.css) does not hide it: WebKitGTK does
 * not advance animations while a Wayland layer is unmapped, so a word drawn then reads as opacity 0
 * for as long as the layer stays unmapped, and the layer maps only once a word takes the mouse.
 *
 * @param {{visibility: string, display: string, opacity: string}} style its computed style
 * @param {Array<{animationName?: string}>} animations its running animations (`getAnimations()`)
 */
export function shownForHits(style, animations = []) {
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (style.opacity !== '0') return true
  return animations.some((animation) => animation.animationName === 'ocr-appear')
}
