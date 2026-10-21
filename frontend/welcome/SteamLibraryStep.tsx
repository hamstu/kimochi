/**
 * Steam Deck / SteamOS in Desktop Mode: put Kimochi in the Steam library, so it is there in Gaming
 * Mode (`steam_library_add`; COMMANDS.md → Steam library). Shown after the dictionary steps when
 * `offersSteamStep` holds; otherwise the route passes straight on to the last step.
 *
 * The preview is the portrait capsule Kimochi installs into Steam's grid folder
 * (`branding/steam/capsule.svg`, rendered at half size by `npm run icons -- --steam`).
 */
import type { JSX } from 'react'
import { Link, Navigate } from 'react-router'
import { Button, Callout, Spinner, StatusDot } from '@kit'
import { useSteamLibrary, type SteamAddResult } from '../bridge/steamLibrary'
import KimochiLogo from '../components/KimochiLogo'
import capsule from './assets/steam-capsule.png'
import Step from './Step'
import { StepActions } from './StepActions'
import style from './WelcomeApp.module.css'

const NEXT = '/done'

/** Steam's own route, for when Kimochi cannot add itself. */
export function SteamManualSteps(): JSX.Element {
  return (
    <p className={style.aside}>
      Or add it yourself: in Steam, choose <strong>Add a Game → Add a Non-Steam Game</strong>, tick{' '}
      <strong>Kimochi</strong>, then <strong>Add Selected Programs</strong>.
    </p>
  )
}

/** The portrait capsule as it sits on a library shelf, between two neighbouring tiles. */
export function SteamTilePreview(): JSX.Element {
  return (
    <figure className={style.steamShelf} aria-label="Kimochi's tile in the Steam library">
      <div className={style.steamTiles} aria-hidden>
        <span className={style.steamNeighbour} />
        <img className={style.steamTile} src={capsule} alt="" width={150} height={225} />
        <span className={style.steamNeighbour} />
      </div>
      <figcaption className={style.steamCaption}>
        <KimochiLogo size={16} />
        Kimochi
      </figcaption>
    </figure>
  )
}

function Outcome({ result }: { result: SteamAddResult }): JSX.Element {
  if (result.state === 'added')
    return (
      <p className={style.status} role="status">
        <StatusDot tone="ok" />
        Kimochi is in your Steam library. Its artwork appears when you return to Gaming Mode.
      </p>
    )
  const tone = result.state === 'pending' || result.state === 'steamNotRunning' ? 'warn' : 'danger'
  return (
    <div className={style.block}>
      <Callout tone={tone}>
        {result.state === 'steamNotRunning'
          ? 'Steam is not running. Open Steam from the desktop, then try again.'
          : result.message}
      </Callout>
      <SteamManualSteps />
    </div>
  )
}

function SteamLibraryScreen(): JSX.Element {
  const { status, adding, result, add } = useSteamLibrary()
  // Back to this step after adding: the library already has Kimochi.
  const outcome: SteamAddResult | null =
    result ?? (status?.added ? { state: 'added', message: '', appId: status.appId } : null)
  const added = outcome?.state === 'added'
  return (
    <Step
      title="Add Kimochi to your Steam library"
      lede="So it’s waiting in Gaming Mode: start Kimochi from your library, then your game, and Kimochi reads alongside it."
    >
      <div className={style.steamShowcase}>
        <SteamTilePreview />
        <div className={style.steamDetail}>
          {adding ? (
            <p className={style.status} role="status">
              <Spinner label="Adding" />
              Adding Kimochi to Steam…
            </p>
          ) : outcome ? (
            <Outcome result={outcome} />
          ) : (
            <p className={style.text}>
              Kimochi adds itself as a non-Steam game, with its own library artwork. Nothing else
              in Steam changes, and you can remove it from Steam like any other game.
            </p>
          )}
        </div>
      </div>
      <StepActions>
        {added ? (
          <Button variant="primary" asChild>
            <Link to={NEXT}>Continue</Link>
          </Button>
        ) : (
          <>
            <Button variant="ghost" asChild>
              <Link to={NEXT}>Skip</Link>
            </Button>
            <Button variant="primary" disabled={adding} onClick={() => void add()}>
              {adding ? 'Adding…' : outcome ? 'Try again' : 'Add to Steam'}
            </Button>
          </>
        )}
      </StepActions>
    </Step>
  )
}

/** The step where it applies; otherwise straight on (once native has answered). */
export default function SteamLibraryStep(): JSX.Element | null {
  const { status, offered } = useSteamLibrary()
  if (status === undefined) return null
  if (!offered) return <Navigate to={NEXT} replace />
  return <SteamLibraryScreen />
}
