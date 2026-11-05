/**
 * The marketing site's live demo (frontend/dev/preview-setup.ts, `?embed=1`) stops what it cannot
 * show and offers the download instead. Most of that happens behind its mocked commands; this is for
 * the few places that never reach one, such as opening Settings. Always false in the app.
 */
export function demoStops(feature: string): boolean {
  const stop = (window as { __kimochiDemoStop?: (feature: string) => boolean }).__kimochiDemoStop
  return stop?.(feature) ?? false
}

/**
 * Whether this is the marketing site's live demo, for what it should not show at all (such as
 * Help, whose forms would send real messages). Set up before the app renders. Always false in the app.
 */
export function inDemo(): boolean {
  return typeof (window as { __kimochiDemoStop?: unknown }).__kimochiDemoStop === 'function'
}
