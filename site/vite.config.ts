import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

// The live demo's example game, shared with the app's preview harness (see README, "Demo").
const DEMO_CONTENT = here('../frontend/dev/demo-content.ts')

/**
 * `vite preview` like production: a path with no file in dist/ (`/x` → x, x.html or x/index.html)
 * gets dist/404.html with status 404 instead of the SPA fallback. The build writes a page for every
 * route (scripts/prerender.mjs), so only unknown paths reach this.
 */
function previewNotFound(): Plugin {
  return {
    name: 'kimochi-preview-404',
    configurePreviewServer(server) {
      const dist = server.config.build.outDir
      const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile()
      server.middlewares.use((req, res, next) => {
        const [raw, query] = (req.url ?? '/').split('?')
        const path = decodeURIComponent(raw).replace(/\/+$/, '')
        if (path === '' || path.startsWith('/api/')) return next()
        const file = join(dist, path)
        // `/compare/` → `/compare`, as Cloudflare does for compare.html.
        if (raw.endsWith('/') && isFile(`${file}.html`)) {
          res.writeHead(307, { Location: path + (query ? `?${query}` : '') })
          return res.end()
        }
        if ([file, `${file}.html`, join(file, 'index.html')].some(isFile)) return next()
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(readFileSync(join(dist, '404.html')))
      })
    }
  }
}

// Static marketing site for Kimochi. Output is plain files in site/dist, served from the domain
// root: every route is a prerendered .html file (scripts/prerender.mjs) and unknown paths should
// get dist/404.html with status 404. In production the kimochi-server Worker serves dist/ (see
// SEO_TODO.md for its not_found_handling setting); public/_headers sets cache and robots headers.
export default defineConfig({
  plugins: [react(), tailwindcss(), previewNotFound()],
  base: '/',
  resolve: { alias: { '@kimochi/demo-content': DEMO_CONTENT } },
  server: {
    // The dev server only serves files under site/ by default; allow the one shared module.
    fs: { allow: [here('.'), DEMO_CONTENT] },
    // Account pages call the API on the same origin. In dev, forward /api to the server's local
    // Kimochi server (`wrangler dev`, PUBLIC_URL=http://127.0.0.1:1450). No changeOrigin: the
    // Host and Origin headers must stay 127.0.0.1:1450 so the server's Origin check passes and
    // its cookies and redirects stay on this origin.
    proxy: { '/api': { target: 'http://127.0.0.1:3000' } }
  },
  preview: { proxy: { '/api': { target: 'http://127.0.0.1:3000' } } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' }
})
