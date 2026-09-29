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
