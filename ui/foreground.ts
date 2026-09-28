/**
 * Deciding whether scanned text still belongs on screen.
 *
 * Ported from src/renderer/src/utils/source-visibility.ts, with two corrections
 * that the Electron rule gets wrong in practice:
 *
 *  - Kimochi's own windows are NEUTRAL. Clicking the controller, the log or the
 *    settings panel makes our app frontmost, which under a naive comparison
 *    would hide the very text the user is about to look up. The last *foreign*
 *    app stays the effective focus.
 *  - An unknown focus shows text. Focus notifications arrive after the restored
 *    source and its first scan, so treating "no signal yet" as "wrong app"
 *    would blank the overlay exactly at startup.
 */

export interface SourceDescriptor {
  kind?: string
  type?: string
  app?: string | null
  appName?: string | null
  name?: string | null
}

const isScreen = (source: SourceDescriptor | undefined | null): boolean =>
  source?.kind === 'display' || source?.kind === 'screen' || source?.type === 'screen'

const appOf = (source: SourceDescriptor | undefined | null): string | null =>
  source?.appName ?? source?.app ?? null

/**
 * Remembers which foreign application is in front, ignoring our own windows.
 *
 * `note` is fed every frontmost-app change the native layer reports, including
 * ours — the caller must not filter, because "Kimochi is frontmost" and "we have
 * had no signal yet" have to stay distinguishable.
 */
export class ForegroundTracker {
  private lastForeign: string | null = null
  private ownNames: string[]

  constructor(ownNames: string[] = ['Kimochi', 'Kimochi Next', 'Kimochi Next POC']) {
    this.ownNames = ownNames.map((n) => n.toLowerCase())
  }

  isOwn(appName: string | null | undefined): boolean {
    if (!appName) return false
    return this.ownNames.includes(appName.toLowerCase())
  }

  note(appName: string | null | undefined): void {
    if (!appName || this.isOwn(appName)) return
    this.lastForeign = appName
  }

  /** The app the user is actually working in, as far as we can tell. */
  get current(): string | null {
    return this.lastForeign
  }

  reset(): void {
    this.lastForeign = null
  }
}

/**
 * What native says about the captured window: see `state.rs`'s `SourceFocus`.
 *
 * `focused` and `present` are answers about a *window*, not an application. Two
 * windows of one app are two different sources, and only one of them is being read.
 */
export interface SourceFocus {
  focused: boolean
  present: boolean
  held?: boolean
}

/**
 * Should the scanned text be on screen at all?
 *
 * Scanned text is a copy of what is on another window, positioned over it. The moment
 * that window is behind something else, minimised or closed, the copy is over nothing,
 * and it has to go visually *and* as a click target — an invisible rectangle that
 * still takes the mouse is worse than a visible one.
 *
 * The window-server answer decides, because it is the only one that can tell two
 * windows of the same application apart. The application-name rules below remain for
 * the cases it does not cover:
 *
 *  - a **screen** capture has no window whose focus could be lost, so it keeps the
 *    documented behaviour: visible unless the app the scan was attributed to has been
 *    left;
 *  - a **window** capture with no native answer yet falls back to those same rules,
 *    rather than blanking text the reader asked for.
 */
export function shouldShowScannedText(
  source: SourceDescriptor | undefined | null,
  focus: SourceFocus | null | undefined,
  focusedAppName: string | null,
  scannedApp: string | null
): boolean {
  const byApp =
    isSourceInForeground(source, focusedAppName) && shouldShowOverlay(scannedApp, focusedAppName)
  if (!source || isScreen(source) || !focus) return byApp
  return focus.focused && focus.present
}

/** A screen source captures everything, so it is always "in front". */
export function isSourceInForeground(
  source: SourceDescriptor | undefined | null,
  focusedAppName: string | null
): boolean {
  return (
    !source ||
    isScreen(source) ||
    !focusedAppName ||
    !appOf(source) ||
    appOf(source) === focusedAppName
  )
}

/**
 * Which app a scan belongs to.
 *
 * A window scan is attributed to the captured window's own app, never to
 * whatever had focus when the scan was triggered — otherwise clicking a native
 * controller would re-attribute the scan to Kimochi and immediately hide it.
 */
export function getScannedAppName(
  source: SourceDescriptor | undefined | null,
  focusedAppName: string | null
): string | null {
  if (!source) return focusedAppName
  return isScreen(source) ? focusedAppName : (appOf(source) ?? null)
}

/** Should the overlay show text from `scannedApp` while `focusedApp` is in front? */
export function shouldShowOverlay(
  scannedApp: string | null,
  focusedApp: string | null
): boolean {
  return !scannedApp || !focusedApp || scannedApp === focusedApp
}
