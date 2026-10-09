/**
 * Builds the DEV preview harness's panel page (frontend/dev/panel.html, the real React windows with
 * the Tauri runtime mocked) as static files in site/public/demo/, served at /demo/ by the marketing
 * site, whose live demo embeds the real Log window from it:
 *
 *   /demo/panel.html?window=log&theme=dark&platform=windows&embed=1
 *
 * `npm run demo:build` (also run by `npm run site:build`). Output is gitignored. Never used by the
 * Tauri app. URL parameters are documented in frontend/dev/preview-setup.ts.
 */
import { fileURLToPath } from 'node:url'
import { mergeConfig, type Plugin, type UserConfig } from 'vite'
import previewConfigExport from './vite.preview.config'

const previewConfig = previewConfigExport as UserConfig
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

const BASE = '/demo/'
const RELAY = 'ui/panel-yomitan.js'

/** Same stub the preview server answers `/ui/panel-yomitan.js` with (vite.preview.config.ts). */
const PANEL_YOMITAN_STUB = `const ok = { ready: true }
export function setEmbeddedEnabled() {}
export async function start() { return ok }
export async function isBackendReachable() { return ok }
export default { setEmbeddedEnabled, start, isBackendReachable }
`

/**
 * The app imports its dictionary relay from the origin root (`/ui/panel-yomitan.js`); on the site
 * that path is not ours, so point it under /demo/ and emit the stub there.
 */
function relayStub(): Plugin {
  return {
    name: 'kimochi-demo-relay-stub',
    apply: 'build',
    transform(code, id) {
      if (!id.endsWith('frontend/shell/panelYomitan.ts')) return null
      return code.replace(/(['"])\/ui\/panel-yomitan\.js\1/, JSON.stringify(BASE + RELAY))
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: RELAY, source: PANEL_YOMITAN_STUB })
    }
  }
}

const config: UserConfig = mergeConfig(previewConfig, {
  // The harness pages live in frontend/dev, so the page is emitted as /demo/panel.html.
  root: here('frontend/dev'),
  base: BASE,
  build: {
    outDir: here('site/public/demo'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 4096
  },
  plugins: [relayStub()]
})

// Replace (not merge) the app's four window inputs: only the harness panel page is embedded.
config.build = { ...config.build, rollupOptions: { ...config.build?.rollupOptions, input: { panel: here('frontend/dev/panel.html') } } }

export default config
