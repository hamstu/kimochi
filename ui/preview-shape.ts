/**
 * The sidebar's live source preview keeps its shape across refreshes (frontend/main/SourcePanel.tsx).
 */
/** How far a new frame's aspect ratio may drift before the preview is reshaped to it. */
export const SHAPE_TOLERANCE = 0.015

/**
 * The preview's size, kept unless the new frame's shape differs by more than `SHAPE_TOLERANCE`.
 * Captures of one window can differ by a few pixels from frame to frame (a shadow, a title bar);
 * following each one changed the sidebar's height by a pixel every refresh, which is enough for
 * the overlay scrollbars of Windows and Linux to appear and fade again and again.
 */
export function keepShape<T extends { width: number; height: number }>(
  current: { width: number; height: number } | null,
  next: T
): { width: number; height: number } {
  if (!current || !(next.width > 0 && next.height > 0)) {
    return current ?? { width: next.width, height: next.height }
  }
  const was = current.width / current.height
  const now = next.width / next.height
  return Math.abs(now - was) / was <= SHAPE_TOLERANCE ? current : { width: next.width, height: next.height }
}
