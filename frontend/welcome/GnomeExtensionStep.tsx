/**
 * GNOME on Wayland (no layer-shell): Kimochi's small GNOME Shell extension, which the overlay,
 * dictionary pop-ups over other apps and desktop crop selection need there. The guide sets it up,
 * as macOS asks for its permissions; launch keeps it in step with the app afterwards
 * (`gnome::update_if_stale`), so Settings has nothing for it.
 */
import { useState, type JSX } from 'react'
import { Link } from 'react-router'
import { Button, StatusDot } from '@kit'
import { awaitingLogin, installGnomeExtension, useGnomeExtension, type InstallResult } from './gnomeExtension'
import PermissionWhy from './PermissionWhy'
import { StepActions } from './StepActions'
import Step from './Step'
import style from './WelcomeApp.module.css'

function GnomeWhy(): JSX.Element {
  return (
    <PermissionWhy title="Why Kimochi needs a GNOME extension">
      <p>
        GNOME doesn’t let apps draw over other windows or know where those windows are on screen. Kimochi’s overlay, its
        dictionary pop-ups over your game and choosing a crop area on the desktop all need that.
      </p>
      <p>
        A small extension, Kimochi Overlay, adds just those to GNOME Shell for Kimochi’s own windows. It runs only on
        this computer, and Kimochi keeps it up to date. You can turn it off any time in GNOME’s Extensions app.
      </p>
      <p>Without it, scanning, the Log and lookups inside Kimochi still work.</p>
    </PermissionWhy>
  )
}

export default function GnomeExtensionStep({ next }: { next: string }): JSX.Element {
  const [status, refresh] = useGnomeExtension(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<InstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const on = status?.available === true
  // Set up, but GNOME only discovers a new extension at the next login. (Installed but not
  // running can also be switched off in Extensions: Set up turns it back on in place.)
  const waiting = awaitingLogin(status, result)
  return (
    <Step
      title="Set up GNOME integration"
      lede={
        <>
          Kimochi adds a small extension to GNOME so its overlay and dictionary pop-ups can appear over your game.
          <GnomeWhy />
        </>
      }
    >
      <p className={style.status} role="status">
        <StatusDot tone={on ? 'ok' : 'warn'} />
        {on
          ? 'The GNOME extension is on.'
          : waiting
            ? 'Set up. Log out and back in once to turn it on; you can finish this guide first.'
            : error
              ? `Couldn’t set it up: ${error}`
              : 'Not set up yet.'}
      </p>
      <StepActions>
        {on || waiting ? (
          <Button variant="primary" asChild>
            <Link to={next}>Continue</Link>
          </Button>
        ) : (
          <>
            <Button variant="ghost" asChild>
              <Link to={next}>{error ? 'Continue without it' : 'Skip for now'}</Link>
            </Button>
            <Button variant="primary" disabled={busy || status === null} onClick={() => void setUp()}>
              {busy ? 'Setting up…' : error ? 'Try again' : 'Set up'}
            </Button>
          </>
        )}
      </StepActions>
    </Step>
  )
}
