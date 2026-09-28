/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Dictionary lookup for a panel window.
 *
 * Installs the relayed `chrome.*` host and starts the original Yomitan frontend,
 * so hovering scanned text in the log window looks words up through the single
 * backend in the overlay — the behaviour Electron gets by loading the extension
 * into every native panel window.
 *
 * ## Do not let this gate your render
 *
 * `start()` reaches across to another window. If the overlay is not up, or its
 * dictionary backend failed, that round trip cannot succeed, and Yomitan's own
 * readiness handshake would sit there for thirty seconds before giving up. So
 * `start()` probes first with a short timeout and **resolves with a status
 * instead of throwing**: call it after your UI has mounted, and render the
 * `error` as an honest "lookup unavailable" state rather than waiting on it.
 *
 * ## What the host page owes the scanner
 *
 * Render scanned text as real text nodes in a stable, non-virtualised list. The
 * scanner walks Ranges over those nodes, so a list that remounts on hover, or
 * text drawn into a canvas or a pseudo-element, cannot be scanned. Call `start()`
 * once that content is in the DOM.
 */

const LABEL_ATTRIBUTE = 'data-kimochi-panel'
const DEFAULT_PROBE_TIMEOUT_MS = 6000

function resolveLabel() {
  return (
    // Native injects the real label at document start for windows whose subframes
    // need the host too. That value is authoritative: the host has already read it.
    window.__kimochiPanelLabel ||
    document.documentElement.getAttribute(LABEL_ATTRIBUTE) ||
    document.body?.dataset?.panel ||
    location.pathname.replace(/^\/|\.html$/g, '') ||
    'panel'
  )
}

// The label becomes this window's tab identity, which must differ from the
// overlay's so backend-side frame routing can never confuse the two.
window.__kimochiPanelLabel = resolveLabel()

await import('/spike/panel-shim.js')

const host = window.__kimochiPanelYomitan
if (!host) {
  throw new Error(
    'Yomitan panel host did not install. Check that host/panel-shim.js reached dist/spike/panel-shim.js.'
  )
}

export const hub = host.hub
export const label = window.__kimochiPanelLabel

/**
 * Ask the overlay's backend one real question.
 *
 * A round trip that returns dictionary info proves the whole chain: the relay
 * command, the overlay window, its extension host and its backend.
 */
export function isBackendReachable(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  // The probe itself lives in the host, because the popup's own window needs the
  // same wait for the same reason: panels are created before the overlay, so a
  // healthy backend may still be importing when the first request arrives.
  return hub.waitForBackend(timeoutMs)
}

/**
 * Start the frontend, scanner and popup in this window.
 *
 * @returns {Promise<{ready: boolean, error?: string}>} never rejects, so it can
 * be called without a try/catch and without blocking the UI.
 */
export async function start({ timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const probe = await isBackendReachable(timeoutMs)
  if (!probe.ready) {
    return {
      ready: false,
      error: `Dictionary lookup is unavailable in the ${label} window: ${probe.error}`
    }
  }
  try {
    await host.start()
    return { ready: true }
  } catch (error) {
    return {
      ready: false,
      error: `Dictionary lookup failed to start in the ${label} window: ${String(error?.message ?? error)}`
    }
  }
}

export default { start, isBackendReachable, hub, label }
