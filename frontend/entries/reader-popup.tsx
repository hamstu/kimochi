import '@ui/install-pointer-dedupe'
import { createRoot } from 'react-dom/client'
import '../kit/kit.css'
import '../texthooker/App.css'
import '../texthooker/popover.css'
import Providers from './providers'
import PopoverApp from '../texthooker/PopoverApp'
import { WindowErrorBoundary } from '../shell/WindowErrorBoundary'
import { reportUncaughtErrors } from './reportErrors'

reportUncaughtErrors('reader-popup')
createRoot(document.getElementById('root')!).render(
  <WindowErrorBoundary window="reader-popup">
    <Providers transparent>
      <PopoverApp />
    </Providers>
  </WindowErrorBoundary>
)
