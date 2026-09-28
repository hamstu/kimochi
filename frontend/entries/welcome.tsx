/**
 * Onboarding window entry. Mirrors `src/renderer/src/windows/welcome/welcome.tsx`, including the
 * transparent Theme background and the HashRouter the screens navigate with.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import { Theme } from '@radix-ui/themes'
import { HashRouter } from 'react-router'
import '@radix-ui/themes/styles.css'
import '../welcome/welcome.css'
import WelcomeApp from '../welcome/WelcomeApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class">
      <Theme style={{ background: 'transparent' }} accentColor="indigo">
        <HashRouter>
          <WelcomeApp />
        </HashRouter>
      </Theme>
    </ThemeProvider>
  </StrictMode>
)
