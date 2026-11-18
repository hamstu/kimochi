/**
 * Settings → Overlay → "Pause the game while reading" (src-tauri/src/game_pause): the switch, what
 * it costs, and the escape hatch that resumes a game Kimochi left paused.
 */
import { useState, type ReactNode } from 'react'
import { Button, SettingsRow, Switch } from '@kit'
import { useSetting } from '../../bridge/useSetting'
import { gamePauseResumeAll, refusalText, useGamePause } from '../../bridge/gamePause'

export function GamePauseRow(): ReactNode {
  const [enabled, setEnabled] = useSetting<boolean>('pauseGameWhileReading', false)
  const info = useGamePause()
  const [resuming, setResuming] = useState(false)
  const supported = info?.capability.supported ?? false
  const status = info?.status
  const paused = status && status.phase !== 'idle'
  const refusal = enabled && status?.refusal ? refusalText(status.refusal.kind) : null
  return (
    <>
      <SettingsRow
        label="Pause the game while reading"
        controlId="game-pause"
        description={
          supported
            ? 'Freezes the game while you look up a word, use the radial menu or draw a region, and resumes it when you’re done. Online games may disconnect, and some games jump ahead on resume. Games with anti-cheat are left running.'
            : (info?.capability.note ?? 'Not available on this system yet.')
        }
      >
        <Switch
          id="game-pause"
          checked={enabled && supported}
          disabled={!supported}
          onCheckedChange={(checked) => void setEnabled(checked)}
        />
      </SettingsRow>
      {supported && (enabled || paused) && (
        <SettingsRow
          label="Resume paused game"
          controlId="game-pause-resume"
          description={
            paused
              ? `The game is paused now (${status?.processes ?? 0} processes).`
              : (refusal ?? 'If a game ever stays frozen, this starts it again.')
          }
        >
          <Button
            id="game-pause-resume"
            disabled={resuming}
            onClick={() => {
              setResuming(true)
              void gamePauseResumeAll()
                .catch(() => undefined)
                .finally(() => setResuming(false))
            }}
          >
            Resume
          </Button>
        </SettingsRow>
      )}
    </>
  )
}
