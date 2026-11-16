/**
 * "Move Kimochi to Applications" (macOS): opened on launch, before anything else, when the app is
 * running from Downloads, a disk image or any other folder outside Applications (`app_location`;
 * COMMANDS.md → App location). Outside Applications macOS leaves Kimochi out of the Screen
 * Recording and System Audio lists and out of Spotlight, and updates cannot replace it.
 *
 * The button moves (or, from a disk image, copies) the app and relaunches it from Applications.
 * If that fails, the dialog says why and how to do it by hand. "Not now" closes it for this run
 * in every window; the next launch asks again. The main window holds What's new back while the
 * move is offered (`useWhatsNewOnLaunch`), the same look as this dialog.
 *
 * `?movetoapps=<state>` in the browser preview opens it (preview-setup.ts).
 */
import { useState, type JSX } from 'react'
import { Button, Callout, Dialog, DialogContent } from '@kit'
import { describeLocation, dismissAppLocation, moveToApplications, type AppLocation } from '../bridge/appLocation'
import { nativeError, quitApp } from '../bridge/tauri'
import '../main/whats-new.css'

type Phase = { kind: 'idle' } | { kind: 'moving' } | { kind: 'failed'; message: string }

function MoveContent({ location, onClose }: { location: AppLocation; onClose: () => void }): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const where = describeLocation(location)
  const move = (): void => {
    setPhase({ kind: 'moving' })
    moveToApplications().then(
      // The app quits and reopens from Applications; the dialog stays on "Moving…" until then.
      () => undefined,
      (error: unknown) => {
        const message = nativeError(error).message
        setPhase(message === 'cancelled' ? { kind: 'idle' } : { kind: 'failed', message })
      }
    )
  }
  const failed = phase.kind === 'failed'

  return (
    <DialogContent
      className="whats-new move-to-apps"
      title="Move Kimochi to Applications"
      onEscapeKeyDown={(event) => phase.kind === 'moving' && event.preventDefault()}
      onPointerDownOutside={(event) => event.preventDefault()}
      footer={
        <>
          <Button
            size="sm"
            variant="ghost"
            className="k-dialog-footer-start"
            disabled={phase.kind === 'moving'}
            onClick={onClose}
          >
            Not now
          </Button>
          {failed ? (
            <Button variant="primary" onClick={() => void quitApp().catch(() => undefined)}>
              Quit Kimochi
            </Button>
          ) : (
            <Button variant="primary" disabled={phase.kind === 'moving'} onClick={move}>
              {phase.kind === 'moving' ? 'Moving…' : 'Move to Applications'}
            </Button>
          )}
        </>
      }
    >
      <section className="whats-new-release">
        <div className="whats-new-notes">
          <p>
            Kimochi is running from <strong>{where}</strong>. macOS only treats it as installed once it is in your
            Applications folder. Until then:
          </p>
          <ul>
            <li>
              It is missing from <strong>Screen Recording</strong> and <strong>System Audio Recording</strong> in System
              Settings, so it cannot be given permission to read your games.
            </li>
            <li>Spotlight and Launchpad do not find it.</li>
            <li>Updates cannot be installed.</li>
          </ul>
          {!failed && (
            <p>
              {location.copyOnly
                ? 'Kimochi can copy itself to Applications and reopen from there.'
                : 'Kimochi can move itself to Applications and reopen from there.'}
              {location.diskImage && ' The disk image is ejected afterwards.'}
              {location.replaces && ' The copy already in Applications goes to the Trash.'}
              {location.needsAdmin && ' macOS will ask for an administrator’s password.'}
            </p>
          )}
          {failed && (
            <>
              <Callout tone="danger">{phase.message}</Callout>
              <p>To move it by hand:</p>
              <ol>
                <li>Quit Kimochi.</li>
                <li>
                  In Finder, drag Kimochi from {location.diskImage ? 'the disk image' : <code>{location.path}</code>} to
                  the <strong>Applications</strong> folder in the sidebar.
                </li>
                <li>Open Kimochi from Applications (or with Spotlight).</li>
              </ol>
            </>
          )}
        </div>
      </section>
    </DialogContent>
  )
}

/** Open while the move is offered: until "Not now" here or in another window, or the next launch. */
export function MoveToApplicationsDialog({ location }: { location: AppLocation | null }): JSX.Element {
  const [closed, setClosed] = useState(false)
  const open = !closed && !!location?.needsMove && !location.dismissed
  const close = (): void => {
    setClosed(true)
    void dismissAppLocation()
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      {open && location && <MoveContent location={location} onClose={close} />}
    </Dialog>
  )
}
