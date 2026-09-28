/**
 * Tray popover entry: the popover shown when the tray icon is clicked.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@radix-ui/themes/styles.css'
import '../shell/panel.css'
import Providers from './providers'
import TrayPopover from '../panels/TrayPopover'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <TrayPopover />
    </Providers>
  </StrictMode>
)
