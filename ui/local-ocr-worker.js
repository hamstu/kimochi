/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The only module that pulls in tesseract.js.
 *
 * Isolated here for two reasons. It is imported dynamically, so the worker, the
 * WASM core and the Japanese language data are never fetched unless local OCR is
 * actually selected or the optional local gate is switched on — both off by
 * default. And it is the one file in `ui/` that needs bundling with a node_modules
 * dependency, which keeps the rest of the directory as plain copied ES modules.
 *
 * The worker and the WASM core are pinned to app-local copies that
 * `scripts/prepare.mjs` ships into `dist/ui/tesseract/`, so starting local OCR
 * does not wait on a CDN.
 *
 * The Japanese language data is NOT vendored — the coordinator ruled that a
 * ~16 MB asset may stay a lazy download as long as it is documented. So
 * `langPath` is deliberately left unset and tesseract.js fetches
 * `jpn.traineddata.gz` from its documented default on first use. Pointing
 * `langPath` at `/ui/tesseract/` without shipping the file there would be worse
 * than the default: it would 404 against the app origin and fail outright
 * instead of falling back. The consequence is that the first local scan needs
 * network access; see PARITY_CONTRACT.md §8.
 */

import { createWorker } from 'tesseract.js'

const ASSET_ROOT = '/ui/tesseract/'

export function createJapaneseWorker() {
  return createWorker('jpn', undefined, {
    workerPath: `${ASSET_ROOT}worker.min.js`,
    corePath: ASSET_ROOT
    // No langPath on purpose: see the note above.
  })
}
