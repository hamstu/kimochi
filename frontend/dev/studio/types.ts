/**
 * DEV-ONLY: the shape of the UI studio's catalogue (frontend/dev/studio/). A surface is one preview
 * page shown in the studio's frame; its controls are the URL parameters that page reads (documented
 * in frontend/dev/preview-setup.ts), grouped and shown only where they apply.
 */

/** Where the reader is inside a surface, read back from its frame (a settings page, a welcome step). */
export type StudioContext = Record<string, string>

export type Control =
  | {
      kind: 'select'
      param: string
      label: string
      options: readonly { value: string; label: string }[]
      /** The value the page uses with the parameter absent; choosing it drops the parameter. */
      default: string
      help?: string
    }
  | {
      kind: 'toggle'
      param: string
      label: string
      /** The parameter's value when on; off drops it, unless `off` names a value to send. */
      on: string
      off?: string
      /** Whether the page is on with the parameter absent. */
      default?: boolean
      help?: string
    }
  | { kind: 'text'; param: string; label: string; placeholder?: string; help?: string }

export interface ControlGroup {
  title: string
  /** Shown only in these contexts (e.g. one settings page); always when absent. */
  when?: (context: StudioContext) => boolean
  controls: readonly Control[]
}

/**
 * Structured state edited as JSON, handed to the frame through `window.parent.__kimochiStudio`
 * (see `studioState` in frontend/dev/studio/bridge.ts): the page reads `json[key]` as it loads.
 */
export interface JsonState {
  key: string
  label: string
  help?: string
  /** What the editor starts from; the page's own default when the reader has not changed it. */
  initial: unknown
  when?: (context: StudioContext) => boolean
}

export interface ContextAxis {
  param: string
  label: string
  /** `params`: what the page needs to show that option (e.g. a Steam Deck for the Steam step), sent unless the reader chose otherwise. */
  options: readonly { value: string; label: string; params?: Record<string, string> }[]
  when?: (context: StudioContext) => boolean
}

export interface Surface {
  id: string
  /** The heading it is listed under in the studio's surface menu. */
  group: string
  label: string
  /** The page under /dev/, e.g. `panel.html`. */
  page: string
  /** Parameters this surface always sends (e.g. `window=settings`). */
  params?: Record<string, string>
  /** The window's own size in the app, and the smallest it can be. */
  size: { width: number; height: number; minWidth?: number; minHeight?: number }
  /** No window around it: the page fills the studio's stage (the overlay, Gaming Mode). */
  frameless?: boolean
  /**
   * Context parameters the studio's own navigation chooses (shown as tabs above the frame), e.g.
   * every settings page or welcome step. The current ones are also read back with `locate`. One
   * axis or several (a second shown only `when` the first makes it apply).
   */
  contexts?: ContextAxis | readonly ContextAxis[]
  /** Where the reader has got to inside the frame, kept when the frame reloads with new state. */
  locate?: (frame: Window) => StudioContext
  groups: readonly ControlGroup[]
  json?: readonly JsonState[]
}
