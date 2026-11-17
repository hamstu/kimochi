/**
 * A ground of faint dotted gridlines, one pixel thick, like a cutting mat or a pixel editor's
 * canvas. Drawn behind the Settings previews of a game (Overlay appearance, the Text Hooker card)
 * and the radial menu's well.
 *
 * It fills its positioned parent, behind what is in it, and is only CSS (grid-field.css). Set where
 * it sits: `--grid-ink`, the lines' colour (a theme token works). Over the grid, an inset: a
 * shadow fading in from the top edge, a fine dark rim, and a one-pixel line of light along the
 * bottom edge, inside and out, as if light caught the lip of a recess.
 */
import type { ReactNode } from 'react'
import './grid-field.css'

export function GridField(): ReactNode {
  return (
    <>
      <span className="grid-field" aria-hidden />
      <span className="grid-field-inset" aria-hidden />
    </>
  )
}
