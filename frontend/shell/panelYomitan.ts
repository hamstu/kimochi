/**
 * Lifecycle for the overlay workstream's dictionary relay (`/ui/panel-yomitan.js`).
 *
 * That module gives a panel window built-in Yomitan lookup against the single backend in the
 * overlay — what Electron got for free by loading the extension into every native panel window. It
 * imposes three requirements, and this module exists to meet all three in the right order:
 *
 *  1. the window's native label must be published BEFORE the module is imported, because it reads
 *     it during evaluation and it becomes this window's tab identity. Without it the module falls
 *     back to the page's pathname — `app/panel` — which every panel window shares, so backend-side
 *     frame routing could not tell them apart;
 *  2. the module must be imported before the window's UI mounts, so its `chrome.*` host is in place;
 *  3. `start()` must be called AFTER the scannable content is in the DOM — importing alone starts
 *     nothing, which is the whole point of it being a separate call.
 *
 * `start()` probes the overlay with a short timeout and resolves with `{ready, error}` rather than
 * rejecting, so it never gates the render. Either way the outcome is shown to the user as an
 * explicit unavailable state, never swallowed.
 */
import { useEffect, useState } from 'react'

const LABEL_ATTRIBUTE = 'data-kimochi-panel'
const RELAY_PATH = '/ui/panel-yomitan.js'

interface StartResult {
  ready: boolean
  error?: string
}

interface PanelYomitan {
  setEmbeddedEnabled: (enabled: boolean) => void
  /** Resolves with a status rather than rejecting, so it can never block the render. */
  start: (options?: { timeoutMs?: number }) => Promise<StartResult>
  isBackendReachable: (timeoutMs?: number) => Promise<StartResult>
}

let relay: Promise<PanelYomitan> | null = null

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Publishes the native window label and imports the relay. Call with a top-level await from the
 * window entry, before React mounts. Resolves to null when the relay is not part of this build.
 */
export async function preloadPanelYomitan(label: string): Promise<PanelYomitan | null> {
  document.documentElement.setAttribute(LABEL_ATTRIBUTE, label)
  // Non-literal specifier: the module is served from the app origin at runtime, not bundled.
  const path = RELAY_PATH
  relay = import(/* @vite-ignore */ path).then((module) => (module.default ?? module) as PanelYomitan)
  try {
    return await relay
  } catch (error) {
    console.warn('[panel] built-in dictionary lookup unavailable:', describe(error))
    return null
  }
}

export type LookupStatus = 'starting' | 'ready' | 'unavailable'

export interface LookupState {
  status: LookupStatus
  /** Why lookup is unavailable, for display. Never only logged. */
  message: string | null
}

/**
 * Starts the relay once this window's content is mounted, and reports the outcome so the window can
 * show an honest state instead of a dictionary that silently never responds.
 */
export function usePanelYomitan(enabled = true): LookupState {
  const [state, setState] = useState<LookupState>({
    status: enabled ? 'starting' : 'unavailable',
    message: null
  })

  useEffect(() => {
    if (relay) void relay.then(module => module.setEmbeddedEnabled(enabled)).catch(() => undefined)
    if (!enabled) return
    let live = true

    const begin = async (): Promise<void> => {
      if (!relay) {
        // The entry did not preload it, so its host shim is not installed and starting now would
        // be after the UI mounted anyway. Report rather than guess.
        if (live) {
          setState({
            status: 'unavailable',
            message: 'The dictionary relay was not loaded for this window.'
          })
        }
        return
      }
      try {
        const module = await relay
        const result = await module.start()
        if (!live) return
        setState(
          result?.ready
            ? { status: 'ready', message: null }
            : {
                status: 'unavailable',
                message: result?.error ?? 'The overlay did not answer.'
              }
        )
      } catch (error) {
        // start() is documented not to reject; treat one as unavailable rather than trusting it.
        if (live) setState({ status: 'unavailable', message: describe(error) })
      }
    }

    void begin()
    return () => {
      live = false
    }
  }, [enabled])

  return state
}
