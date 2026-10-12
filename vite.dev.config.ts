/**
 * The dev server behind `tauri dev` (`build.devUrl` / `beforeDevCommand` in
 * src-tauri/tauri.conf.json). One origin, `http://127.0.0.1:1430`, serves the whole app:
 *
 * - `/app/*`: the React windows straight from `frontend/`, with Vite HMR.
 * - everything else: the prepared `dist/` tree (the Yomitan copy, `dist/spike/` from `host/`,
 *   `dist/ui/` from `ui/`), byte for byte, as `tauri dev`'s own static server used to.
 * - a watcher on `ui/` and `host/` that redoes that directory's `scripts/prepare.mjs` step and
 *   then reloads the pages that load it (for `host/`, `scripts/run.mjs dev` relaunches the app
 *   instead).
 *
 * Two more origins serve the vendored dictionary extensions for browser testing outside Tauri
 * (DICTIONARY_ENGINES.md §4, §9): `KIMOCHI_DEV_PORT + 10` is Hachidori (`dist/ext/hachidori/`),
 * `+ 11` is 10ten (`dist/ext/tenten/`), each with `/__kimochi/` → `dist/spike/`. In Tauri the
 * custom schemes `hachidori://` and `tenten://` do this job and these ports are unused.
 *
 * The origin is deliberately the one Tauri's built-in static server used, so a dev build keeps
 * its IndexedDB (the dev dictionaries) and localStorage. `KIMOCHI_DEV_PORT` moves it, e.g. for a
 * second checkout; `scripts/run.mjs dev` passes the matching `devUrl` to `tauri dev`.
 * Never used by `vite build` or a bundle.
 */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeConfig, type Plugin, type UserConfig, type ViteDevServer } from 'vite'
import appConfigExport from './vite.config'
import { dist, prepare, prepareExtensions, prepareHost, prepareUi } from './scripts/prepare.mjs'
import {
  createExtensionServer,
  createProxyMiddleware,
  createRelayBus,
  harnessInjectsYomitanShim,
  injectHostScript,
  scopeFromCapability,
  YOMITAN_SHIM_TAG
} from './scripts/ext-dev-server.mjs'

const appConfig = appConfigExport as UserConfig
const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url))
const port = Number(process.env.KIMOCHI_DEV_PORT ?? 1430)
/** Engine id → its dev origin's port. Fixed offsets so a second checkout moves them together. */
const EXTENSION_PORTS: Record<string, number> = { hachidori: port + 10, tenten: port + 11 }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.handlebars': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  // 10ten's dictionary data (`data/words.ljson`, `data/words.idx`): read as bytes, not text.
  '.ljson': 'application/octet-stream',
  '.idx': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip'
}

/** Served at this path and loaded by every `dist/ui/` page, the top-level windows outside React. */
const RELOAD_CLIENT_PATH = '/@kimochi-dev/reload.js'
const RELOAD_EVENT = 'kimochi:static-reload'
// Vite's own client also performs `full-reload`. Only top-level documents connect: a reload of
// the window reloads its frames too, and Yomitan's frames should not each open a socket.
const RELOAD_CLIENT = `if (window === window.top) {
  const { createHotContext } = await import('/app/@vite/client')
  createHotContext('${RELOAD_CLIENT_PATH}').on('${RELOAD_EVENT}', () => location.reload())
}
`

/** `ui/` files a React window imports from dist/ at runtime rather than through Vite. */
/** A `dist/` file for a request path, or null when there is none (never a directory). */
async function distFile(urlPath: string): Promise<string | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  const file = path.join(dist, path.normalize(decoded))
  if (file !== dist && !file.startsWith(dist + path.sep)) return null
  const info = await stat(file).catch(() => null)
  return info?.isFile() ? file : null
}

function kimochiDev(): Plugin {
  let server: ViteDevServer
  const ui = here('ui')
  const host = here('host')
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> = Promise.resolve()

  const flush = async (): Promise<void> => {
    const files = [...pending]
    pending.clear()
    const inside = (dir: string) => (file: string) => file.startsWith(dir + path.sep)
    const hostFiles = files.filter(inside(host))
    const uiFiles = files.filter(inside(ui))
    const started = Date.now()
    try {
      if (uiFiles.length > 0) await prepareUi()
      if (hostFiles.length > 0) await prepareHost()
    } catch (error) {
      server.config.logger.error(`[kimochi] dist/ rebuild failed: ${(error as Error).message}`, {
        timestamp: true
      })
      return
    }
    const names = files.map((file) => path.relative(here('.'), file)).join(', ')
    // Every window reloads for any `ui/` or `host/` change, not only the plain `ui/` pages that
    // load the changed file. The windows share Yomitan state across native window boundaries:
    // the Log's dictionary popup lives in `ui/popup-host.html`, and the Log's popup factory
    // registers that popup by id. Reloading popup-host alone left the Log holding an id the
    // new popup-host never issued, and its first hide came back as an unhandled "Invalid popup
    // ID" rejection on the Log's error banner. A `ui/` edit is rare enough that losing the React
    // windows' state costs less than that.
    const everywhere = true
    // `scripts/run.mjs dev` has `tauri dev` relaunch the app for `host/` edits, because native
    // injects the Yomitan shims (built from `host/yomitan/`) at window creation and a reload keeps the old
    // copy. Reloading as well would only be undone a moment later.
    const relaunching = hostFiles.length > 0 && process.env.KIMOCHI_DEV_HOST_RELAUNCH === '1'
    let outcome: string
    if (relaunching) outcome = 'tauri dev relaunches the app'
    else if (everywhere) {
      server.ws.send({ type: 'full-reload' })
      outcome = 'reloaded every window'
    } else {
      server.ws.send({ type: 'custom', event: RELOAD_EVENT })
      outcome = 'reloaded the ui/ pages'
    }
    server.config.logger.info(
      `[kimochi] dist/ updated in ${Date.now() - started} ms (${names}); ${outcome}`,
      { timestamp: true }
    )
    const injected = hostFiles.filter((file) => /[\\/]host[\\/](yomitan[\\/]|ext[\\/])/.test(file))
    if (injected.length > 0 && !relaunching) {
      server.config.logger.warn(
        `[kimochi] ${injected.map((file) => path.basename(file)).join(', ')} is injected by native at window creation: restart the app to apply it (\`npm run dev\` does so itself).`,
        { timestamp: true }
      )
    }
  }

  const onChange = (file: string): void => {
    if (!file.startsWith(ui + path.sep) && !file.startsWith(host + path.sep)) return
    pending.add(file)
    clearTimeout(timer)
    timer = setTimeout(() => {
      running = running.then(flush)
    }, 80)
  }

  return {
    name: 'kimochi-dev',
    apply: 'serve',
    async configureServer(devServer) {
      server = devServer
      // A missing Yomitan copy means `dist/` was never prepared (a bare `npx tauri dev`). Otherwise
      // only redo ui/ and host/, picking up edits made while no server ran, and leave `dist/app/`.
      if (await distFile('/manifest.json')) {
        await prepareUi()
        await prepareHost()
      } else {
        await prepare()
      }
      // `extensions/` is never edited in place, so it is copied once rather than watched.
      if (!(await stat(path.join(dist, 'ext')).catch(() => null))) await prepareExtensions()
      // The browser harness's plugin-http stand-in (ui/dictionary-harness.js `?fetch=proxy`):
      // loopback only, limited to the hosts the app's own network capability allows. Mounted on
      // the extension origins too, where the extension window's page fetches.
      const capability = JSON.parse(await readFile(here('src-tauri/capabilities/network.json'), 'utf8'))
      const proxy = createProxyMiddleware({
        scope: scopeFromCapability(capability),
        log: (message: string) => server.config.logger.warn(`[kimochi] ${message}`, { timestamp: true })
      })
      // The harness's `ext_relay` stand-in, one bus for every origin (ext-dev-server.mjs).
      const relay = createRelayBus()
      startExtensionServers(server, [proxy, relay.middleware])
      server.watcher.add([ui, host])
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, onChange)

      server.middlewares.use(proxy)
      server.middlewares.use(relay.middleware)

      // Registered before Vite's own middlewares: anything outside `/app/` is the static origin.
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '/').split(/[?#]/)[0]
        if (url.startsWith('/app/') || (req.method !== 'GET' && req.method !== 'HEAD')) return next()
        if (url === RELOAD_CLIENT_PATH) {
          res.setHeader('Content-Type', MIME['.js'])
          res.setHeader('Cache-Control', 'no-store')
          res.end(RELOAD_CLIENT)
          return
        }
        const file = await distFile(url)
        if (!file) return next()
        const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
        res.setHeader('Content-Type', type)
        res.setHeader('Cache-Control', 'no-store')
        if (url.startsWith('/ui/') && file.endsWith('.html')) {
          const html = await readFile(file, 'utf8')
          const tag = `<script type="module" src="${RELOAD_CLIENT_PATH}"></script>`
          // Appended rather than put first: anything before the doctype would mean quirks mode.
          res.end(html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag)
          return
        }
        // The harness's stand-in for native's all-frames Yomitan shim (see ext-dev-server.mjs).
        if (file.endsWith('.html') && harnessInjectsYomitanShim(req.headers.cookie)) {
          const html = await readFile(file, 'utf8')
          res.end(req.method === 'HEAD' ? undefined : injectHostScript(html, YOMITAN_SHIM_TAG))
          return
        }
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        createReadStream(file).on('error', next).pipe(res)
      })
    }
  }
}

/** The two extension origins (see the header), closed with the dev server. */
type Middleware = (req: unknown, res: unknown, next: () => void) => unknown

function startExtensionServers(server: ViteDevServer, middleware: Middleware[]): void {
  const servers: Server[] = []
  const logger = server.config.logger
  for (const [id, extPort] of Object.entries(EXTENSION_PORTS)) {
    const http = createExtensionServer({
      extRoot: path.join(dist, 'ext', id),
      spikeRoot: path.join(dist, 'spike'),
      mime: MIME,
      log: (message: string) => logger.error(`[kimochi] ${id} origin: ${message}`, { timestamp: true }),
      middleware,
      // The extension window's page in the harness gets the native stand-in from the app origin.
      harnessScript: `http://127.0.0.1:${port}/ui/dictionary-harness-native.js`
    }) as Server
    // A config change makes Vite restart: the new listeners race the old ones, which are still
    // draining keep-alive connections, so the port can be busy for a moment. Retried briefly;
    // anything else is reported, not fatal: the app never uses these ports, only browser tests.
    let attempts = 0
    const listen = (): void => {
      http.listen(extPort, '127.0.0.1', () => {
        logger.info(`[kimochi] ${id} dev origin: http://127.0.0.1:${extPort}/`, { timestamp: true })
      })
    }
    http.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && attempts++ < 20) {
        setTimeout(listen, 250)
        return
      }
      logger.warn(`[kimochi] ${id} dev origin on port ${extPort} unavailable: ${error.message}`, {
        timestamp: true
      })
    })
    listen()
    servers.push(http)
  }
  server.httpServer?.once('close', () => {
    for (const http of servers) {
      // Drop idle keep-alive connections too, or the port stays taken until they time out.
      http.closeAllConnections?.()
      http.close()
    }
  })
}

export default mergeConfig(appConfig, {
  // The React windows load as `app/<entry>.html`, as they do from a bundle's `dist/app/`.
  base: '/app/',
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    open: false,
    // `src-tauri/` is `tauri dev`'s to watch; the dev server only serves frontend files.
    watch: { ignored: ['**/src-tauri/**', '**/dist/**'] }
  },
  plugins: [kimochiDev()]
})
