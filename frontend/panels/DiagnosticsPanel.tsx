/**
 * The Diagnostics window: the capture preview, the debug coordinates and the capture debugger,
 * which were three separate windows, as three views switched from the title bar. Only the shown
 * view is mounted, so the hidden ones stop polling.
 */
import { useState, type JSX } from 'react'
import { Segmented } from '@kit'
import { TitleBarPortal } from '../shell/TitleBarPortal'
import CapturePanel from './CapturePanel'
import DebugPanel from './DebugPanel'
import CaptureDebugPanel from './CaptureDebugPanel'

type Tab = 'preview' | 'coordinates' | 'capture'

const TABS = [
  { value: 'preview', label: 'Preview' },
  { value: 'coordinates', label: 'Coordinates' },
  { value: 'capture', label: 'Capture test' }
] as const

export default function DiagnosticsPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>('preview')
  return (
    <>
      <TitleBarPortal>
        <span className="native-titlebar-title diag-title">Diagnostics</span>
        <span className="diag-title-spacer" />
        <Segmented aria-label="Diagnostics view" value={tab} onValueChange={setTab} options={TABS} />
      </TitleBarPortal>
      <div className={tab === 'preview' ? 'diag-view' : 'diag-view diag-view-dark'}>
        {tab === 'preview' && <CapturePanel />}
        {tab === 'coordinates' && <DebugPanel />}
        {tab === 'capture' && <CaptureDebugPanel />}
      </div>
    </>
  )
}
