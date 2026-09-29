/**
 * DEV-ONLY browser preview of every React window, with the Tauri runtime mocked.
 * `npm run preview:ui`, then open http://localhost:5199/dev/ (see frontend/dev/preview-setup.ts).
 * Never used by `vite build` or the Tauri app.
 */
import { fileURLToPath } from 'node:url'
import { mergeConfig, type Plugin, type UserConfig } from 'vite'
import appConfigExport from './vite.config'

const appConfig = appConfigExport as UserConfig

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))
const mock = (name: string): string => here(`frontend/dev/mocks/${name}.ts`)

/** `preloadPanelYomitan` imports `/ui/panel-yomitan.js` from the app origin at runtime. */
const PANEL_YOMITAN_STUB = `
const ok = { ready: true }
export function setEmbeddedEnabled() {}
export async function start() { return ok }
export async function isBackendReachable() { return ok }
export default { setEmbeddedEnabled, start, isBackendReachable }
`

function previewServer(): Plugin {
  return {
    name: 'kimochi-preview-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (url === '/ui/panel-yomitan.js') {
          res.setHeader('Content-Type', 'text/javascript')
          res.end(PANEL_YOMITAN_STUB)
          return
        }
        if (url === '/' || url === '/dev') {
          res.statusCode = 302
          res.setHeader('Location', '/dev/')
          res.end()
          return
        }
        next()
      })
    }
  }
}

// Derive from the app config so aliases/plugins added there (e.g. by the redesign) carry over.
export default mergeConfig(appConfig, {
  base: '/',
  resolve: {
    alias: {
      '@tauri-apps/plugin-fs': mock('plugin-fs'),
      '@tauri-apps/plugin-dialog': mock('plugin-dialog'),
      '@tauri-apps/plugin-clipboard-manager': mock('plugin-clipboard-manager'),
      '@tauri-apps/plugin-shell': mock('plugin-shell'),
      '@tauri-apps/plugin-http': mock('plugin-http')
    }
  },
  server: { port: Number(process.env.PREVIEW_PORT ?? 5199), strictPort: true, open: false },
  plugins: [previewServer()]
})
