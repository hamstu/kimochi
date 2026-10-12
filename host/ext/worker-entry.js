/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * The worker shim (worker-network.js), bundled by scripts/prepare.mjs into
 * `dist/spike/ext-worker.js` and started by extension frames as
 * `<origin>/__kimochi/ext-worker.js?src=<real worker script>` with the worker's own options
 * (`type: 'module'`, its `name`). It relays the worker's remote `fetch` to the frame, then imports
 * the real script.
 */
import { runWorkerShim } from './worker-network.js'

void runWorkerShim(self)
