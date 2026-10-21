/**
 * Settings → General → Steam library (Linux with Steam): add Kimochi to the Steam library, so it
 * starts from there in Gaming Mode, or see that it is there. The same action as the welcome
 * guide's Steam step (`steam_library_add`; COMMANDS.md → Steam library).
 */
import type { ReactNode } from 'react'
import { Badge, Button, Callout, SettingsRow, SettingsSection, Spinner } from '@kit'
import { useSteamLibrary } from '../../bridge/steamLibrary'

function description(added: boolean, artwork: boolean, gamingMode: boolean): string {
  if (added && !artwork)
    return 'Kimochi is in your Steam library. Its artwork appears once Steam restarts, as it does when you switch to Gaming Mode.'
  if (added) return 'Kimochi is in your Steam library. Start it there in Gaming Mode, then your game.'
  if (gamingMode)
    return 'Adds Kimochi as a non-Steam game with its own artwork. Steam shows it after you next return to the library.'
  return 'Adds Kimochi as a non-Steam game with its own artwork, so it is there in Gaming Mode.'
}

export function SteamLibrarySection(): ReactNode {
  const { status, adding, result, add } = useSteamLibrary()
  if (!status?.supported || !status.steamInstalled) return null
  const failed = result && result.state !== 'added'
  return (
    <SettingsSection title="Steam library">
      <SettingsRow
        label="Kimochi in Steam"
        badge={status.added ? <Badge tone="ok">Added</Badge> : undefined}
        description={description(status.added, status.artwork, status.gamingMode)}
      >
        {adding ? (
          <Spinner label="Adding to Steam" />
        ) : status.added && status.launcher ? null : (
          <Button size="sm" variant={status.added ? 'secondary' : 'primary'} onClick={() => void add()}>
            {/* Added before, from another copy of Kimochi: point the launcher at this one. */}
            {status.added ? 'Update' : 'Add to Steam'}
          </Button>
        )}
      </SettingsRow>
      {failed && (
        <Callout tone={result.state === 'failed' ? 'danger' : 'warn'}>
          {result.state === 'steamNotRunning'
            ? 'Steam is not running. Open Steam, then try again.'
            : result.message}{' '}
          Or add it yourself: in Steam, choose Add a Game → Add a Non-Steam Game, tick Kimochi, then
          Add Selected Programs.
        </Callout>
      )}
    </SettingsSection>
  )
}
