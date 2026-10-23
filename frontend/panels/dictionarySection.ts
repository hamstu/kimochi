/**
 * Built-in Yomitan's settings page, scrolled to one of its sections once it is laid out.
 *
 * The page builds itself after it loads: settings-main.js prepares every settings controller
 * (options, dictionaries, Anki, …) and only then sets `<html data-loaded="true">`, which its CSS
 * waits for before laying the sections out. A fragment in the frame's first URL
 * (`/settings.html#anki`) is applied at load, before that, so the page opened at the top; a
 * fragment applied later (the window already open) landed. So the section is scrolled to once the
 * page says it is loaded. Hachidori's page is on its own origin and handles its fragment itself.
 */

/** The parts of a frame's document this needs (a real `Document` in the app; a fake in tests). */
export interface SectionDocument {
  documentElement: { dataset: Record<string, string | undefined> }
  getElementById: (id: string) => { scrollIntoView: (options?: ScrollIntoViewOptions) => void } | null
}

export interface RevealOptions {
  /** How long to wait for the page to finish loading. */
  timeoutMs?: number
  /** How often to look again. */
  intervalMs?: number
  wait?: (ms: number) => Promise<void>
  /** Waits for the page to paint its new layout before scrolling. */
  nextFrame?: () => Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const twoFrames = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

/**
 * Scrolls `section` of the document `getDocument` returns into view once that document is loaded
 * (`data-loaded="true"`). Resolves true when it scrolled; false when the page did not finish in
 * time, has no such section, or is gone (`getDocument` returning null, e.g. a cross-origin frame).
 */
export async function revealSectionWhenLoaded(
  getDocument: () => SectionDocument | null,
  section: string,
  { timeoutMs = 15000, intervalMs = 100, wait = sleep, nextFrame = twoFrames }: RevealOptions = {}
): Promise<boolean> {
  for (let waited = 0; ; waited += intervalMs) {
    const doc = getDocument()
    if (!doc) return false
    if (doc.documentElement.dataset.loaded === 'true') break
    if (waited >= timeoutMs) return false
    await wait(intervalMs)
  }
  await nextFrame()
  const target = getDocument()?.getElementById(section)
  if (!target) return false
  target.scrollIntoView({ block: 'start' })
  return true
}

/** A same-origin frame's document, or null (not loaded, or another origin). */
export function frameDocument(frame: HTMLIFrameElement | null): Document | null {
  try {
    return frame?.contentDocument ?? null
  } catch {
    return null
  }
}
