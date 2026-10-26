/**
 * The Diagnostics window: the capture preview, the debug coordinates, the capture debugger (which
 * were three separate windows) and sentence audio's listener, as views switched from the title
 * bar. Only the shown view is mounted, so the hidden ones stop polling.
 */
import { useState, type JSX } from 'react'
import { Segmented } from '@kit'
import { TitleBarPortal } from '../shell/TitleBarPortal'
import CapturePanel from './CapturePanel'
import DebugPanel from './DebugPanel'
import CaptureDebugPanel from './CaptureDebugPanel'
import SentenceAudioDebugPanel from './SentenceAudioDebugPanel'

type Tab = 'preview' | 'coordinates' | 'capture' | 'audio'

const TABS = [
  { value: 'preview', label: 'Preview' },
  { value: 'coordinates', label: 'Coordinates' },
  { value: 'capture', label: 'Capture test' },
  { value: 'audio', label: 'Sentence audio' }
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
        {tab === 'audio' && <SentenceAudioDebugPanel />}
      </div>
    </>
  )
}
