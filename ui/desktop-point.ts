/**
 * Desktop points from a pointer event's screen coordinates.
 *
 * Native commands that place a window at the pointer (`show_popover`) take desktop points: one
 * CSS pixel of a page on that display, laid out as Chromium lays out its screen (COMMANDS.md,
 * "desktop geometry"). A page's `event.screenX/Y` is Chromium's screen coordinate, which is
 * that same thing only while the webview renders at the display's DPI scale. On Windows WebView2
 * can render larger (Windows' Text size is folded into its device scale factor), and then
 * `screenX` is the desktop point divided by the extra factor, whatever page zoom native applies
 * to put CSS pixels right (`webview_scale.rs`): page zoom corrects `clientX` and the viewport,
 * never screen coordinates. Native reports the factor with each sync and the Windows prelude
 * keeps it in `__KIMOCHI_PLATFORM__.screenScale`; it is 1 everywhere else.
 *
 * Events native replays into a page (the overlay's `pointer` feed, `popup-host:pointer`) carry
 * desktop points as their screen coordinates already, and are not trusted events, so they pass
 * through unchanged.
 *
 * Plain DOM with no imports: the overlay loads `ui/` modules as they are, without a bundler.
 */

interface PlatformInfo {
  screenScale?: unknown
}

/** The factor that takes a trusted event's `screenX/Y` to desktop points (1 when none is known). */
export function screenScale(): number {
  const read = (win: Window | null | undefined): number | null => {
    try {
      const value = (win as (Window & { __KIMOCHI_PLATFORM__?: PlatformInfo }) | null | undefined)
        ?.__KIMOCHI_PLATFORM__?.screenScale
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
    } catch {
      return null // a cross-origin top
    }
  }
  if (typeof window === 'undefined') return 1
  // Only the top-level page syncs with native; a same-origin frame reads its answer.
  return read(window) ?? (window.top !== window ? read(window.top) : null) ?? 1
}

export interface ScreenPointEvent {
  screenX: number
  screenY: number
  /** False for an event a script dispatched: a replay from native, already in desktop points. */
  isTrusted?: boolean
}

/** Where `event` happened, in desktop points. */
export function desktopPointOf(event: ScreenPointEvent): { x: number; y: number } {
  const scale = event.isTrusted === false ? 1 : screenScale()
  return { x: event.screenX * scale, y: event.screenY * scale }
}
