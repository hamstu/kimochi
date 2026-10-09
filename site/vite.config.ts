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
  // The dev server only serves files under site/ by default; allow the one shared module.
  server: { fs: { allow: [here('.'), DEMO_CONTENT] } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' }
})
