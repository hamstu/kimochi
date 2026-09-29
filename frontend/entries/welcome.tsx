/**
 * Onboarding window entry. Mirrors `src/renderer/src/windows/welcome/welcome.tsx`, including the
 * transparent Theme background and the HashRouter the screens navigate with.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Providers from './providers'
import { HashRouter } from 'react-router'
import '@radix-ui/themes/styles.css'
import '../kit/kit.css'
import '../welcome/welcome.css'
import WelcomeApp from '../welcome/WelcomeApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers transparent>
      <HashRouter>
        <WelcomeApp />
      </HashRouter>
    </Providers>
  </StrictMode>
)
