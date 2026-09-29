import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

// The Tauri window origin is `dist/`, which `scripts/prepare.mjs` builds as a byte-identical copy
// of the repository's `yomitan/` extension plus `host/` and `ui/`. The React bundle therefore emits
// into `dist/app/`, a path that does not exist in `yomitan/` (which has welcome.html and search.html
// at its root, so panel entries may not live at the root). `npm run verify` must keep passing.
export default defineConfig({
  root: here('frontend'),
  base: './',
  resolve: {
    alias: {
      // Plain-ESM modules owned by the overlay agent, shared rather than duplicated.
      '@ui': here('ui'),
      '@texthooker': here('frontend/texthooker')
    }
  },
  build: {
    outDir: here('dist/app'),
    emptyOutDir: true,
    target: 'safari17',
    sourcemap: true,
    rollupOptions: {
      input: {
        panel: here('frontend/panel.html'),
        'reader-popup': here('frontend/reader-popup.html'),
        'source-picker': here('frontend/source-picker.html'),
        welcome: here('frontend/welcome.html'),
        'tray-popover': here('frontend/tray-popover.html')
      }
    }
  },
  plugins: [react(), tailwindcss()]
})
