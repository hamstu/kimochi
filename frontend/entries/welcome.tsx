/**
 * Onboarding window entry. The guide sits in the same panel chrome as every other Kimochi window
 * (`PanelShell`: title bar, drag region, pin, minimize, close), with the HashRouter its steps
 * navigate with.
 */
import '@ui/install-pointer-dedupe'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import '@radix-ui/themes/styles.css'
import '../kit/kit.css'
import '../shell/panel.css'
import Providers from './providers'
import PanelShell from '../shell/PanelShell'
import WelcomeApp from '../welcome/WelcomeApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <PanelShell label="welcome" title="Welcome to Kimochi">
        <HashRouter>
          <WelcomeApp />
        </HashRouter>
      </PanelShell>
    </Providers>
  </StrictMode>
)
