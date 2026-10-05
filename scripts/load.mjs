/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helper. */
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Bundle a TypeScript module from `ui/` and import it in-process.
 *
 * Bundling rather than transforming a single file keeps cross-module imports
 * (autoscan.ts -> dhash.js) working without writing anything to disk, so the
 * tests observe exactly the source under `ui/` and never a stale `dist/` copy.
 */
export async function load(entry) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(`../ui/${entry}`, import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022'
  })
  const code = Buffer.from(outputFiles[0].contents).toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}
