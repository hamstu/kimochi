/**
 * Lifecycle for dictionary lookup in a panel window (the Log), whichever engine is active.
 *
 * The engine is the one this document's injected host scripts resolved at document start
 * (`documentEngine`), not the live setting: the host decides what can run here, and a switch
 * reloads the window (DICTIONARY_ENGINES.md §2).
 *
 * - Yomitan: the overlay workstream's relay, `/ui/panel-yomitan.js`, described below.
 * - Hachidori, 10ten: a small adapter over `window.__kimochiExtensionHost`, which native injected
 *   at document start. Its `start({host: false, scope})` registers this window's content context
 *   with the overlay's hub and injects the extension's content scripts, confined to the
 *   transcript (`[data-yomitan-scan]`). Same `{ready, error}` contract.
 * - Kimochi's pop-up runs over the Yomitan host, so it takes the Yomitan path; the Log turns it
 *   off (`usePanelDictionary(false)`) and looks words up through the API itself.
 *
 * The Yomitan relay gives a panel window built-in Yomitan lookup against the single backend in the
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
import { NO_ENGINE, NO_ENGINE_MESSAGE, documentEngine, extensionHost } from '../bridge/dictionaryEngine'

const LABEL_ATTRIBUTE = 'data-kimochi-panel'
const RELAY_PATH = '/ui/panel-yomitan.js'

interface StartResult {
  ready: boolean
  error?: string
}

/** What every engine's lookup looks like to this window. */
interface PanelDictionary {
  setEmbeddedEnabled: (enabled: boolean) => void
  /** Resolves with a status rather than rejecting, so it can never block the render. */
  start: (options?: { timeoutMs?: number }) => Promise<StartResult>
  isBackendReachable: (timeoutMs?: number) => Promise<StartResult>
}

let relay: Promise<PanelDictionary> | null = null

/** The transcript lines, which are all a content script may scan in the Log. */
const SCAN_SCOPE = '[data-yomitan-scan]'
/** As long as the Yomitan relay's own probe allows for the overlay to answer. */
const EXTENSION_START_TIMEOUT_MS = 15000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ])
}

/**
 * The extension host as a `PanelDictionary`. Null when the host did not install, which is a
 * native injection fault worth saying out loud rather than a quiet fallback to Yomitan.
 */
function extensionAdapter(): PanelDictionary | null {
  const host = extensionHost()
  if (!host) return null
  const settle = (promise: Promise<StartResult>, timeoutMs: number): Promise<StartResult> =>
    withTimeout(promise, timeoutMs, 'The overlay did not answer.').catch((error: unknown) => ({
      ready: false,
      error: describe(error)
    }))
  return {
    setEmbeddedEnabled: (enabled) => host.setEnabled(enabled),
    // `start` is idempotent and never rejects; the timeout only bounds a hub that never answers.
    start: ({ timeoutMs = EXTENSION_START_TIMEOUT_MS } = {}) =>
      settle(host.start({ host: false, scope: SCAN_SCOPE }), timeoutMs),
    isBackendReachable: (timeoutMs = EXTENSION_START_TIMEOUT_MS) =>
      settle(
        host.ready.then(() => ({ ready: true })),
        timeoutMs
      )
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Publishes the native window label and readies this window's engine (for Yomitan, imports the
 * relay). Call with a top-level await from the window entry, before React mounts. Resolves to
 * null when lookup is not available in this build or window.
 */
export async function preloadPanelDictionary(label: string): Promise<PanelDictionary | null> {
  document.documentElement.setAttribute(LABEL_ATTRIBUTE, label)
  const engine = documentEngine()
  if (engine === NO_ENGINE) {
    // No engine is downloaded: the lookup state says so (and where to get one), honestly.
    relay = Promise.reject(new Error(NO_ENGINE_MESSAGE))
    relay.catch(() => undefined)
    return null
  }
  if (engine !== 'yomitan') {
    const adapter = extensionAdapter()
    if (!adapter) {
      console.warn(`[panel] the ${engine} extension host is not installed in this window`)
      relay = Promise.reject(
        new Error(`The ${engine === 'tenten' ? '10ten' : 'Hachidori'} host did not load in this window.`)
      )
      relay.catch(() => undefined)
      return null
    }
    relay = Promise.resolve(adapter)
    return adapter
  }
  // Non-literal specifier: the module is served from the app origin at runtime, not bundled.
  const path = RELAY_PATH
  relay = import(/* @vite-ignore */ path).then((module) => (module.default ?? module) as PanelDictionary)
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
export function usePanelDictionary(enabled = true): LookupState {
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

/** The names from before the other engines; kept so older call sites read the same. */
export const preloadPanelYomitan = preloadPanelDictionary
export const usePanelYomitan = usePanelDictionary
