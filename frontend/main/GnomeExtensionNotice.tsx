/**
 * GNOME on Wayland without Kimochi's GNOME extension running: the overlay reads "Overlay
 * unavailable". The welcome guide normally sets the extension up; this is the way back for a reader
 * who skipped it, set Kimochi up before the guide had the step, or turned the extension off.
 */
import { useState, type JSX } from 'react'
import { Callout } from '@kit'
import { awaitingLogin, installGnomeExtension, useGnomeExtension, type InstallResult } from '../welcome/gnomeExtension'

export function GnomeExtensionNotice(): JSX.Element | null {
  const [status, refresh] = useGnomeExtension(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<InstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Null off GNOME and until the status is known; nothing to say once the extension is running.
  if (!status || status.available) return null

  const setUp = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setResult(await installGnomeExtension())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const waiting = awaitingLogin(status, result)
  return (
    <Callout tone="warn" className="src-notice">
      <span>
        {waiting ? (
          <>
            <strong>GNOME extension set up.</strong> Log out and back in once to turn on the overlay.
          </>
        ) : error ? (
          <>
            <strong>Couldn&rsquo;t set up the GNOME extension.</strong> {error}
          </>
        ) : (
          <>
            <strong>The overlay needs Kimochi&rsquo;s GNOME extension.</strong> It also adds dictionary pop-ups over
            your game and region selection on the desktop.
          </>
        )}
      </span>
      {!waiting && (
        <button type="button" className="k-link src-notice-link" disabled={busy} onClick={() => void setUp()}>
          {busy ? 'Setting up…' : error ? 'Try again' : 'Set up'}
        </button>
      )}
    </Callout>
  )
}
