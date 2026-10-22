/** DEV-ONLY: the UI studio's entry (frontend/dev/studio.html); see Studio.tsx. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@radix-ui/themes/styles.css'
import '../../kit/kit.css'
import './studio.css'
import { Studio } from './Studio'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Studio />
  </StrictMode>
)
