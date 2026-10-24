/**
 * Settings → Game mode: Kimochi over a game, driven by a controller or the keyboard. How Read along
 * shows the dictionary (the pop-up beside the word, or the full-screen dictionary that only the
 * Yomitan API can feed), and the buttons the controller menu and Read along use.
 */
import type { ReactNode } from 'react'
import { Badge, Button, Callout, ChoiceGroup, SettingsPage, SettingsRow, SettingsSection, StatusDot } from '@kit'
import {
  DEFAULT_GAME_MODE_SETTINGS,
  DICTIONARY_ENGINES,
  dictionaryEngineOf,
  type GameDictionaryView,
  type GameModeSettings
} from '@ui/settings'
import { resolveYomitanApiUrl } from '@ui/yomitan-api-setup'
import type { YomitanSettings } from '../../vendor/shared-types'
import { useSetting } from '../../bridge/useSetting'
import { useYomitanApiSetup } from '../../bridge/yomitanApi'
import { ControllerButtonSections } from './GamepadSections'
import { showSettingsTab } from './showSettingsTab'

/** The reader settings Add to Anki reads (the Log's `superTexthooker`); only what decides readiness. */
interface ReaderAnki {
  ankiEnabled?: boolean
  ankiDeckName?: string
  ankiModelName?: string
  ankiModelFields?: string[]
}

/** The same rule as the pop-up's Add to Anki (`popupAnkiConfig` in ui/api-lookup.js). */
const ankiReady = (reader: ReaderAnki | null): boolean =>
  Boolean(reader?.ankiEnabled && reader.ankiDeckName && reader.ankiModelName && reader.ankiModelFields?.length)

export function GameModeTab(): ReactNode {
  const [gameMode, setGameMode] = useSetting<GameModeSettings>('gameModeSettings', DEFAULT_GAME_MODE_SETTINGS)
  const [yomitan] = useSetting<YomitanSettings>('yomitanSettings', { popupType: 'builtin', customApiUrl: '' })
  const [reader] = useSetting<ReaderAnki | null>('superTexthooker', null)
  const engine = dictionaryEngineOf(yomitan.popupType)
  const api = engine === 'custom-api'
  const view = gameMode?.dictionaryView === 'fullscreen' ? 'fullscreen' : 'popup'

  return (
    <SettingsPage
      title="Game mode"
      description="Kimochi over a game, with a controller or the keyboard: the controller menu, Read along and recent text."
    >
      <SettingsSection
        title="Dictionary in Read along"
        description="How the dictionary shows while you step through a scan word by word."
      >
        <div className="game-mode-choice">
          <ChoiceGroup<GameDictionaryView>
            aria-label="Dictionary in Read along"
            value={view}
            onValueChange={(next) => void setGameMode({ ...DEFAULT_GAME_MODE_SETTINGS, ...gameMode, dictionaryView: next })}
            options={[
              {
                value: 'popup',
                label: 'Pop-up beside the word',
                detail: "An outline on the game's text, with your dictionary's own pop-up next to it. Works with every dictionary."
              },
              {
                value: 'fullscreen',
                label: 'Full screen',
                detail:
                  'The whole scan across the top of a dimmed screen, one word lit and its entry below. The D-pad moves word to word, the shoulder buttons through its entries, and A adds it to Anki.',
                disabled: !api && view !== 'fullscreen'
              }
            ]}
          />
        </div>
        {api ? (
          <ApiState url={resolveYomitanApiUrl(yomitan.customApiUrl)} />
        ) : (
          <div className="settings-note">
            <Callout tone={view === 'fullscreen' ? 'warn' : 'neutral'}>
              <span>
                Full screen needs the <strong>Yomitan API</strong>, the only dictionary that hands Kimochi the words and
                entries to lay out. You are using {DICTIONARY_ENGINES[engine].name}, which draws its own pop-up
                {view === 'fullscreen' ? ', so Read along uses the pop-up until you switch.' : '.'}
              </span>
              <Button size="sm" onClick={() => showSettingsTab('dictionary')}>
                Use the Yomitan API
              </Button>
            </Callout>
          </div>
        )}
        {api && view === 'fullscreen' && (
          <SettingsRow
            label="Add to Anki"
            description={
              ankiReady(reader)
                ? 'A adds the entry on screen with your Anki settings, the scanned text as its sentence.'
                : 'Set a deck, a note type and its fields in Anki to add cards from the full-screen dictionary.'
            }
            badge={ankiReady(reader) ? <Badge tone="ok">Ready</Badge> : <Badge tone="warn">Not set up</Badge>}
          >
            <Button size="sm" onClick={() => showSettingsTab('anki')}>
              Anki settings
            </Button>
          </SettingsRow>
        )}
      </SettingsSection>

      <ControllerButtonSections />
    </SettingsPage>
  )
}

/** Whether the Yomitan API answers now, checked every few seconds while the page is open. */
function ApiState({ url }: { url: string }): ReactNode {
  const { api } = useYomitanApiSetup(url, { apiEveryMs: 5000, hostEveryMs: 60000 })
  const answering = Boolean(api?.yomitan)
  return (
    <SettingsRow
      label={
        <span className="game-mode-api">
          <StatusDot tone={api === null ? 'neutral' : answering ? 'ok' : 'warn'} />
          {api === null ? 'Checking the Yomitan API…' : answering ? 'The Yomitan API is answering' : 'The Yomitan API is not answering'}
        </span>
      }
      description={
        answering
          ? `Using ${url}.`
          : 'Open your browser with Yomitan, or finish its setup in Dictionary. Read along needs it to look words up.'
      }
    >
      {!answering && api !== null && (
        <Button size="sm" onClick={() => showSettingsTab('dictionary')}>
          Dictionary
        </Button>
      )}
    </SettingsRow>
  )
}
