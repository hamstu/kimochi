/**
 * Resolve the CSS cursor seen by the inactive-window hover bridge to the
 * explicit AppKit cursor it should keep installed.
 *
 * WebKit reports `auto` for ordinary transcript text even though its own
 * cursor resolution displays an I-beam. Passing that `auto` through to the
 * native bridge used to select the arrow every 50 ms, racing WebKit's I-beam.
 */
export function resolveNativeCursor(
  cssCursor: string,
  disabled: boolean,
  transcriptText: boolean,
): string {
  if (disabled) return "default";
  if (cssCursor === "auto" && transcriptText) return "text";
  return cssCursor;
}

/**
 * Whether a viewport point is over rendered text glyphs, not just inside a text element's box.
 *
 * WebKit shows the I-beam only over the text itself; over a line's padding, the empty space to
 * the right of a short line, or the gap between lines it shows the arrow. The bridge must make
 * the same call, or it keeps reasserting an I-beam that WebKit immediately replaces, and the
 * cursor flickers between the two.
 */
export function isPointOverText(x: number, y: number): boolean {
  const range = document.caretRangeFromPoint?.(x, y);
  const node = range?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return false;
  const probe = document.createRange();
  probe.selectNodeContents(node);
  for (const rect of probe.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}
