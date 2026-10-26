/**
 * Settings → Game Mode: how Read along shows the dictionary, the pop-up beside the word or the
 * full-screen dictionary, as two pictures to pick from. The buttons Game Mode uses are on
 * Shortcuts & Controls (`GamepadSections`).
 */
import type { ReactNode } from 'react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { SettingsPage, SettingsSection } from '@kit'
import { DEFAULT_GAME_MODE_SETTINGS, type GameDictionaryView, type GameModeSettings } from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { FullscreenArt, PopupArt } from './ReadAlongArt'
import './game-mode.css'

const VIEWS: { value: GameDictionaryView; label: string; detail: string; art: ReactNode }[] = [
  { value: 'popup', label: 'Pop-up', detail: 'Beside the word.', art: <PopupArt /> },
  { value: 'fullscreen', label: 'Full screen', detail: 'Over the whole game.', art: <FullscreenArt /> }
]

export function GameModeTab(): ReactNode {
  const [gameMode, setGameMode] = useSetting<GameModeSettings>('gameModeSettings', DEFAULT_GAME_MODE_SETTINGS)
  const view: GameDictionaryView = gameMode?.dictionaryView === 'fullscreen' ? 'fullscreen' : 'popup'

  return (
    <SettingsPage title="Game Mode" description="Kimochi over a game, with a controller or the keyboard.">
      <SettingsSection title="Dictionary in Read along" grouped={false}>
        <ToggleGroup.Root
          type="single"
          value={view}
          onValueChange={(next) =>
            next && void setGameMode({ ...DEFAULT_GAME_MODE_SETTINGS, ...gameMode, dictionaryView: next as GameDictionaryView })
          }
          className="read-along-views"
          aria-label="Dictionary in Read along"
        >
          {VIEWS.map((option) => (
            <ToggleGroup.Item key={option.value} value={option.value} className="read-along-view">
              <span className="read-along-view-art">{option.art}</span>
              <span className="read-along-view-text">
                <span className="read-along-view-radio" aria-hidden />
                <span className="read-along-view-label">{option.label}</span>
                <span className="read-along-view-detail">{option.detail}</span>
              </span>
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
      </SettingsSection>
    </SettingsPage>
  )
}
