/**
 * Whether an unhandled rejection in an app window came from the Yomitan engine's own scripts,
 * which run in the Log so its words can be looked up. They are served from the app origin under
 * `/js/` (DICTIONARY_ENGINES.md); Kimochi's own code never is. Its internal messaging fails on its
 * own now and then ("Acknowledgement timeout (popupFactoryHide)") with nothing the reader can do,
 * so the Log leaves these to the diagnostics log (host/yomitan/panel.js `panel-rejection`) instead
 * of showing an error.
 *
 * @param {unknown} reason
 * @returns {boolean}
 */
export function isEngineRejection(reason) {
  const stack = reason && typeof reason === 'object' && 'stack' in reason ? String(reason.stack ?? '') : ''
  // The first frame names where the error was made: `fn@tauri://localhost/js/comm/…` (WebKit) or
  // `at fn (http://127.0.0.1:1430/js/comm/…)` (Chromium).
  const first = stack.split('\n').find((line) => /\w+:\/\//.test(line)) ?? ''
  return /\w+:\/\/[^/\s]+\/js\//.test(first)
}
