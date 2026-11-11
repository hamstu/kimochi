/**
 * Editing a shared screen's region on a Linux layer-shell overlay (KDE Plasma, Hyprland, Sway and
 * other wlroots compositors).
 *
 * The overlay is one layer surface, which covers one output at a time. A shared screen is a
 * rectangle of the compositor's global logical layout (`sourceBounds` of `source_hover_preview`):
 * one output, primary or not, or several at once (KDE's "Full Workspace" share). The editor goes
 * to the output under the pointer, or the one the saved region is on, and is limited there to the
 * part of the screen that output shows; it follows the pointer to the screen's other outputs while
 * nothing is being drawn, the way the macOS and Windows editors follow it between displays. A
 * region is on one output; it is saved in the screen's own frame pixels.
 *
 * `outputs` and the pointer come from `layer_outputs` (src-tauri/src/platform/linux/screens.rs),
 * in the same global logical space as the screen. Every rectangle here is `{x, y, width, height}`.
 */

/** The part of `a` inside `b`, or null. */
export function intersect(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right - x >= 1 && bottom - y >= 1 ? { x, y, width: right - x, height: bottom - y } : null
}

const contains = (r, p) => p && p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height
export const sameRect = (a, b) =>
  Boolean(a && b) &&
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5

/** The outputs showing some of `screen`. */
export function screenOutputs(screen, outputs) {
  return (outputs ?? []).filter((o) => intersect(screen, o))
}

/** The output among `pieces` holding `point`, or null. */
export function outputAt(pieces, point) {
  return pieces.find((o) => contains(o, point)) ?? null
}

/** A saved crop (frame pixels at its reference size) as a rectangle in the global layout. */
export function cropToGlobal(crop, screen) {
  if (!crop?.reference_width || !crop?.reference_height) return null
  const sx = screen.width / crop.reference_width
  const sy = screen.height / crop.reference_height
  return { x: screen.x + crop.x * sx, y: screen.y + crop.y * sy, width: crop.width * sx, height: crop.height * sy }
}

/**
 * Where the editor opens: the output under the pointer, else the one holding the saved region's
 * centre, else the overlay's own, else the one showing most of the screen. Null when the screen is
 * on no output (a virtual one, or one that is off).
 */
export function startOutput(screen, outputs, { pointer = null, saved = null, current = null } = {}) {
  const pieces = screenOutputs(screen, outputs)
  if (!pieces.length) return null
  const region = saved ? cropToGlobal(saved, screen) : null
  const centre = region ? { x: region.x + region.width / 2, y: region.y + region.height / 2 } : null
  const area = (o) => {
    const r = intersect(screen, o)
    return r ? r.width * r.height : 0
  }
  return (
    outputAt(pieces, pointer) ??
    outputAt(pieces, centre) ??
    pieces.find((o) => sameRect(o, current)) ??
    pieces.reduce((best, o) => (area(o) > area(best) ? o : best))
  )
}

/** The part of the screen on `output`, in that output's (the overlay's) points. */
export function outputArea(screen, output) {
  const r = intersect(screen, output)
  return r && { x: r.x - output.x, y: r.y - output.y, width: r.width, height: r.height }
}

/** A saved crop as a box in `output`'s points, cut to the screen's part there; null when off it. */
export function cropToOutput(crop, screen, output) {
  const region = cropToGlobal(crop, screen)
  const area = outputArea(screen, output)
  if (!region || !area) return null
  const local = { x: region.x - output.x, y: region.y - output.y, width: region.width, height: region.height }
  const cut = intersect(local, area)
  return cut && { x: Math.round(cut.x), y: Math.round(cut.y), width: Math.round(cut.width), height: Math.round(cut.height) }
}

/** A box drawn on `output` (its points) as a crop of the screen's frame (`frame` pixels). */
export function cropFromOutput(rect, screen, output, frame) {
  const sx = frame.width / screen.width
  const sy = frame.height / screen.height
  const left = Math.max(0, Math.round((rect.x + output.x - screen.x) * sx))
  const top = Math.max(0, Math.round((rect.y + output.y - screen.y) * sy))
  const right = Math.min(frame.width, Math.round((rect.x + rect.width + output.x - screen.x) * sx))
  const bottom = Math.min(frame.height, Math.round((rect.y + rect.height + output.y - screen.y) * sy))
  if (right <= left || bottom <= top) return null
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    reference_width: frame.width,
    reference_height: frame.height
  }
}
