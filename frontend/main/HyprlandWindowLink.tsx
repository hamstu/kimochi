import {useEffect, useState} from 'react'
import {invoke} from '@tauri-apps/api/core'
import {Button, Dialog, DialogContent} from '@kit'
import {useCapabilities} from '../bridge/capabilities'
import {nativeError} from '../bridge/tauri'

interface Candidate {address: string; title: string; app: string}
interface Status {available: boolean; linked: boolean}

/** A portal has no window identity. Equal-sized candidates need an explicit choice. */
export function HyprlandWindowLink({sourceId}: {sourceId?: string}): React.JSX.Element | null {
  const caps = useCapabilities()
  const eligible = window.__KIMOCHI_PLATFORM__?.os === 'linux' && caps.session?.backend === 'wayland'
    && caps.session.compositor === 'Hyprland' && caps.overlay.passive && Boolean(sourceId?.startsWith('portal:window:'))
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!eligible || !sourceId) return
    let alive = true
    const load = async (explicit = false): Promise<void> => {
      try {
        // Preview supplies dimensions and attempts a unique, current-frame match.
        await invoke('source_hover_preview', {sourceId})
        const status = await invoke<Status>('linux_window_geometry', {operation: 'status', sourceId, windowAddress: null})
        if (!alive || (!explicit && status.linked)) return
        const windows = await invoke<Candidate[]>('linux_window_geometry', {operation: 'candidates', sourceId, windowAddress: null})
        if (!alive) return
        setCandidates(windows)
        setSelected(windows.length === 1 ? windows[0].address : '')
        setError(null)
        setOpen(true)
      } catch (caught) {
        if (alive && explicit) {setError(nativeError(caught).message); setOpen(true)}
      }
    }
    const request = (): void => {void load(true)}
    window.addEventListener('kimochi-link-window', request)
    void load()
    return () => {alive = false; window.removeEventListener('kimochi-link-window', request)}
  }, [eligible, sourceId])

  if (!eligible) return null
  const link = async (): Promise<void> => {
    if (!selected || !sourceId) return
    setBusy(true)
    try {
      await invoke('linux_window_geometry', {operation: 'link', sourceId, windowAddress: selected})
      setOpen(false)
    } catch (caught) {setError(nativeError(caught).message)}
    finally {setBusy(false)}
  }
  return <Dialog open={open} onOpenChange={value => {if (!busy) setOpen(value)}}>
    <DialogContent title="Link the shared window"
      description="Choose the same window you selected in the system sharing picker. This lets annotations and crop selection follow it on the desktop."
      footer={<><Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary" disabled={!selected || busy} onClick={() => void link()}>{busy ? 'Linking…' : 'Link window'}</Button></>}>
      {error && <p role="alert">{error}</p>}
      {candidates.length === 0 && <p>No matching window is available. Bring the shared window into view and try “Relink window overlay…” in the source menu, or share the screen instead.</p>}
      <div role="group" aria-label="Windows matching the shared source">
        {candidates.map(candidate => <Button key={candidate.address} variant={selected === candidate.address ? 'primary' : 'ghost'}
          aria-pressed={selected === candidate.address} disabled={busy}
          data-window-address={candidate.address} onClick={() => setSelected(candidate.address)}
          style={{width: '100%', justifyContent: 'flex-start', marginBottom: 4}}>
          {candidate.title || candidate.app}
        </Button>)}
      </div>
    </DialogContent>
  </Dialog>
}
