import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Checkbox, ConfirmDialog } from '@kit'
import { getSetting, setSetting } from '../bridge/settings'
import { useCapabilities } from '../bridge/capabilities'

/** `source_elevation` (elevation.rs): the chosen source's rights next to Kimochi's. */
interface SourceElevation {
  sourceId: string | null
  kind?: 'window' | 'display'
  name?: string
  app?: string
  rights?: 'elevated' | 'locked' | 'same' | 'unknown'
  selfElevated: boolean
  skipped?: boolean
  offer: boolean
}

const SKIP_KEY = 'elevationPromptSkipped'

/**
 * Windows only (#216): a game that runs as administrator hides its keys from a Kimochi that does
 * not, so holding Shift over its text looks nothing up. When the chosen source is such a game,
 * offer to restart Kimochi as administrator (`relaunch_elevated`). Native announces it with
 * `source-elevation` when a source is chosen; the dialog also asks once on load, for a source
 * restored at startup before this page listened.
 */
export function ElevationDialog(): React.JSX.Element | null {
  const windows = useCapabilities().os === 'windows'
  const [status, setStatus] = useState<SourceElevation | null>(null)
  const [open, setOpen] = useState(false)
  const [skip, setSkip] = useState(false)
  const [busy, setBusy] = useState(false)
  const [declined, setDeclined] = useState(false)

  useEffect(() => {
    if (!windows) return
    let alive = true
    const show = (next: SourceElevation): void => {
      if (!alive || !next.offer || !next.sourceId) return
      setStatus(next)
      setSkip(false)
      setDeclined(false)
      setOpen(true)
    }
    void invoke<SourceElevation>('source_elevation')
      .then(show)
      .catch(() => undefined)
    const stop = listen<SourceElevation>('source-elevation', ({ payload }) => show(payload))
    return () => {
      alive = false
      void stop.then((fn) => fn())
    }
  }, [windows])

  if (!windows || !status) return null

  const close = async (): Promise<void> => {
    setOpen(false)
    if (!skip || !status.app) return
    const list = await getSetting<string[]>(SKIP_KEY, [])
    if (!list.some((name) => name.toLowerCase() === status.app?.toLowerCase())) {
      await setSetting(SKIP_KEY, [...list, status.app])
    }
  }

  const relaunch = async (): Promise<void> => {
    setBusy(true)
    setDeclined(false)
    try {
      // Kimochi quits once the administrator copy is running; nothing after this runs then.
      await invoke('relaunch_elevated')
    } catch (error) {
      setBusy(false)
      setDeclined(String(error).includes('cancelled'))
      if (!String(error).includes('cancelled')) console.error('[elevation] restart failed:', error)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void close()
      }}
      title="Kimochi needs to run as administrator"
      description={
        <>
          <span className="elevation-copy">
            The source you selected runs as administrator, so some Kimochi features won’t work until Kimochi does too.
          </span>
          {declined && (
            <span className="elevation-copy elevation-declined">
              Windows didn’t give permission. Try again, or choose another source.
            </span>
          )}
          {status.app && (
            <label className="elevation-skip">
              <Checkbox checked={skip} onCheckedChange={(on) => setSkip(on === true)} />
              Don’t ask again for this game
            </label>
          )}
        </>
      }
      cancelLabel="Not now"
      confirmLabel={busy ? 'Waiting for Windows…' : 'Restart as administrator'}
      busy={busy}
      onConfirm={() => void relaunch()}
    />
  )
}
