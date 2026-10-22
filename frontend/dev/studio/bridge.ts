/**
 * DEV-ONLY: what a preview page reads from the UI studio around it. The studio keeps its JSON
 * state on its own window (`__kimochiStudio`); a page in its frame is same-origin and reads it as it
 * loads. Outside the studio (a preview page opened on its own) there is none.
 */
export interface StudioState {
  json: Record<string, unknown>
}

export function studioState(): StudioState | null {
  try {
    if (window.parent === window) return null
    return (window.parent as unknown as { __kimochiStudio?: StudioState }).__kimochiStudio ?? null
  } catch {
    return null
  }
}

/** The studio's JSON state for `key`, or undefined when the studio has none (use the page's own). */
export function studioJson<T>(key: string): T | undefined {
  return studioState()?.json[key] as T | undefined
}
