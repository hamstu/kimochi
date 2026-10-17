import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

// The live demo's example game, shared with the app's preview harness (see README, "Demo").
const DEMO_CONTENT = here('../frontend/dev/demo-content.ts')

// Static marketing site for Kimochi. Output is plain files in site/dist, served from the domain
// root; the host must rewrite unknown paths to /index.html (client-side routes).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  resolve: { alias: { '@kimochi/demo-content': DEMO_CONTENT } },
  server: {
    // The dev server only serves files under site/ by default; allow the one shared module.
    fs: { allow: [here('.'), DEMO_CONTENT] },
    // Account pages call the API on the same origin. In dev, forward /api to the server's local
    // `wrangler dev` (kimochi-server, PUBLIC_URL=http://127.0.0.1:1450). No changeOrigin: the
    // Host and Origin headers must stay 127.0.0.1:1450 so the server's Origin check passes and
    // its cookies and redirects stay on this origin.
    proxy: { '/api': { target: 'http://127.0.0.1:3000' } }
  },
  preview: { proxy: { '/api': { target: 'http://127.0.0.1:3000' } } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' }
})
