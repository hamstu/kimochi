import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import './styles/index.css'

const root = document.getElementById('root')!
const app = (
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)

// Marketing pages arrive prerendered (scripts/prerender.mjs) and are hydrated; account pages, and
// every page in the dev server, arrive as an empty shell and render here.
if (root.hasChildNodes()) hydrateRoot(root, app)
else createRoot(root).render(app)

// Dev only: the in-place copy editor (src/dev/CopyEditor.tsx). Never part of a production build.
if (import.meta.env.DEV) void import('./dev/CopyEditor').then((m) => m.mountCopyEditor())
