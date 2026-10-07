import {useState} from 'react'
import {invoke} from '@tauri-apps/api/core'
import {useCapabilities} from '../bridge/capabilities'

declare global {
  interface Window { __KIMOCHI_PLATFORM__?: {os: string} }
}

/** Optional compositor integration; other Linux desktops retain their native paths. */
export function GnomeOverlaySetup(): React.JSX.Element | null {
  const caps = useCapabilities()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  if (window.__KIMOCHI_PLATFORM__?.os !== 'linux' || caps.session?.backend !== 'wayland' || caps.session.compositor !== 'GNOME' || caps.session.layerShell)
    return null
  const install = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await invoke<{message: string}>('gnome_overlay', {operation: 'update', payload: null})
      setMessage(result.message)
    } catch (error) { setMessage(String(error)) }
    finally { setBusy(false) }
  }
  return <div className="src-controls">
    <button type="button" className="k-row src-row" disabled={busy} onClick={() => void install()}>
      {busy ? 'Updating…' : caps.overlay.passive ? 'Update GNOME overlay' : 'Set up GNOME overlay'}
    </button>
    {message && <p role="status">{message}</p>}
  </div>
}
