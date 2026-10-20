import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import './styles/index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)

// Dev only: the in-place copy editor (src/dev/CopyEditor.tsx). Never part of a production build.
if (import.meta.env.DEV) void import('./dev/CopyEditor').then((m) => m.mountCopyEditor())
