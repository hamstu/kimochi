/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Build helper. */
/**
 * The two Yomitan host bundles (DICTIONARY_ENGINES.md §11.4): `dist/spike/shim.js` (the overlay's
 * backend-owning host) and `dist/spike/panel-shim.js` (the relay client of every other window),
 * built from `host/yomitan/` on the primitives in `host/ext/primitives.js`.
 *
 * Classic IIFEs because native injects them as document-start scripts for every frame, and
 * unminified so a stack trace from a user's report still names the host's functions. Shared by
 * scripts/prepare.mjs (to `dist/spike/`) and the node tests (in memory, run in `node:vm`).
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Published name under `dist/spike/` → entry module. */
export const YOMITAN_SHIMS = {
  'shim.js': 'host/yomitan/overlay.js',
  'panel-shim.js': 'host/yomitan/panel.js'
}

const options = (name) => ({
  entryPoints: [root + YOMITAN_SHIMS[name]],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'safari17',
  legalComments: 'inline',
  logLevel: 'silent'
})

/** Write both bundles into `outdir` (`dist/spike`). */
export async function buildYomitanShims(outdir) {
  for (const name of Object.keys(YOMITAN_SHIMS)) {
    await build({ ...options(name), outfile: `${outdir}/${name}` })
  }
}

/**
 * One bundle's source text, for the tests. `network` replaces the panel host's dynamic import of
 * the network adapter (`/spike/network-bundle.js`), which `node:vm` cannot load, with an
 * expression of the caller's choosing.
 */
export async function yomitanShimSource(name, { network } = {}) {
  const { outputFiles } = await build({ ...options(name), write: false })
  let text = outputFiles[0].text
  if (network !== undefined) {
    const stubbed = text.replace(/import\(asset\(["']\/spike\/network-bundle\.js["']\)\)/, network)
    if (stubbed === text && name === 'panel-shim.js') throw Error('The network import to stub is gone from panel-shim.js')
    text = stubbed
  }
  return text
}
