/**
 * Settings → Dictionary: which lookup pop-up to use, then everything that belongs to it. Yomitan's
 * pop-up keeps its dictionaries, audio and Anki mining in Yomitan's own settings; Kimochi's pop-up
 * (over a Yomitan API server) is set up here, including its Anki card builder.
 */
import { useCallback, useState, type ReactNode } from 'react'
import { BookOpen, Sparkles } from 'lucide-react'
import {
  Badge,
  Button,
  Callout,
  ChoiceGroup,
  Input,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubgroup,
  Slider,
  StatusDot,
  Switch,
  type Tone
} from '@kit'
import type { PopupType, YomitanSettings } from '../../vendor/shared-types'
import { API_URLS } from '../../vendor/shared-constants'
import { useSetting } from '../../bridge/useSetting'
import { nativeError, panel } from '../../bridge/tauri'
import { describeUrlRestriction, testApiConnection } from '../../bridge/yomitan'
import { AnkiSetup } from '@texthooker/components/AnkiSetup'
import { clearAudioCache } from '@texthooker/lib/audio'
import { updateSettings } from '@texthooker/lib/settings'
import type { Settings } from '@texthooker/lib/types'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { NumberField } from './fields'

type TestStatus = 'idle' | 'testing' | 'success' | 'error'

const POPUP_OPTIONS = [
  {
    value: 'builtin',
    label: 'Yomitan pop-up',
    icon: <BookOpen />,
    detail: 'Yomitan itself, running inside Kimochi, with its own dictionaries, audio and Anki mining.'
  },
  {
    value: 'custom-api',
    label: (
      <>
        Kimochi pop-up <Badge tone="warn">Experimental</Badge>
      </>
    ),
    icon: <Sparkles />,
    detail: 'Click words in the Log to look them up through a Yomitan API server, and build Anki cards here.'
  }
] as const

const STATUS_TONE: Record<TestStatus, Tone> = {
  idle: 'neutral',
  testing: 'warn',
  success: 'ok',
  error: 'danger'
}

const STATUS_LABEL: Record<TestStatus, string> = {
  idle: 'Not tested',
  testing: 'Testing',
  success: 'Connected',
  error: 'Connection failed'
}

export function DictionaryTab(): ReactNode {
  const [yomitanSettings, setYomitanSettings] = useSetting<YomitanSettings>('yomitanSettings', {
    popupType: 'builtin',
    customApiUrl: API_URLS.YOMITAN_FALLBACK
  })
  const [apiTestStatus, setApiTestStatus] = useState<TestStatus>('idle')

  const handlePopupTypeChange = useCallback(
    (value: PopupType): void => {
      void setYomitanSettings({ ...yomitanSettings, popupType: value })
      // Reset test status when changing popup type
      if (value === 'builtin') setApiTestStatus('idle')
    },
    [yomitanSettings, setYomitanSettings]
  )

  const handleApiUrlChange = useCallback(
    (value: string): void => {
      void setYomitanSettings({ ...yomitanSettings, customApiUrl: value })
      setApiTestStatus('idle')
    },
    [yomitanSettings, setYomitanSettings]
  )

  const handleTestApiConnection = useCallback(async (): Promise<void> => {
    setApiTestStatus('testing')
    try {
      const result = await testApiConnection(yomitanSettings.customApiUrl)
      setApiTestStatus(result.success ? 'success' : 'error')
      if (!result.success) console.error('API test failed:', result.error)
    } catch (error) {
      console.error('Failed to test API connection:', error)
      setApiTestStatus('error')
    }
  }, [yomitanSettings.customApiUrl])

  const restriction = yomitanSettings.customApiUrl
    ? describeUrlRestriction(yomitanSettings.customApiUrl)
    : null

  return (
    <SettingsPage title="Dictionary" description="The pop-up that shows definitions when you look up a word.">
      <SettingsSection title="Pop-up">
        <div className="settings-choice">
          <ChoiceGroup
            aria-label="Pop-up"
            value={yomitanSettings.popupType}
            onValueChange={(value) => handlePopupTypeChange(value)}
            options={POPUP_OPTIONS}
          />
        </div>

        {yomitanSettings.popupType === 'builtin' && (
          <SettingsRow
            label="Yomitan settings"
            description="Dictionaries, scanning, audio and Anki mining for this pop-up are all set up in Yomitan's own settings."
          >
            <Button
              size="sm"
              onClick={() => {
                panel('yomitan', 'show').catch((error) =>
                  console.error('Open Yomitan settings failed:', nativeError(error).message)
                )
              }}
            >
              Open Yomitan settings
            </Button>
          </SettingsRow>
        )}

        {yomitanSettings.popupType === 'custom-api' && (
          <SettingsRow
            stacked
            label="Yomitan API URL"
            controlId="dictionary-api-url"
            description="The URL of your Yomitan API endpoint. Test verifies the connection."
          >
            <div className="settings-url">
              <span title={STATUS_LABEL[apiTestStatus]} className="settings-url-status">
                <StatusDot tone={STATUS_TONE[apiTestStatus]} />
              </span>
              <span className="sr-only" role="status">
                {STATUS_LABEL[apiTestStatus]}
              </span>
              <Input
                id="dictionary-api-url"
                mono
                value={yomitanSettings.customApiUrl}
                onChange={(e) => handleApiUrlChange(e.target.value)}
                placeholder={API_URLS.YOMITAN_FALLBACK}
              />
              <Button onClick={() => void handleTestApiConnection()} disabled={apiTestStatus === 'testing'}>
                {apiTestStatus === 'testing' ? 'Testing…' : 'Test'}
              </Button>
            </div>
          </SettingsRow>
        )}
        {yomitanSettings.popupType === 'custom-api' && restriction && (
          <div className="settings-note">
            <Callout tone="warn">{restriction}</Callout>
          </div>
        )}
      </SettingsSection>

      {yomitanSettings.popupType === 'custom-api' && (
        <WithReaderSettings>{(settings) => <KimochiPopupSections settings={settings} />}</WithReaderSettings>
      )}
    </SettingsPage>
  )
}

/** Everything that only applies to Kimochi's own pop-up. */
function KimochiPopupSections({ settings }: { settings: Settings }): ReactNode {
  const volume = Math.round(settings.audioVolume * 100)
  return (
    <div className="texthooker">
      <SettingsSection title="In the Log">
        <SettingsRow
          label="Click a word to look it up"
          controlId="dictionary-click"
          description="Off makes the text selectable instead. Shift-hover still looks words up."
        >
          <Switch
            id="dictionary-click"
            checked={!settings.disableClickToDefine}
            onCheckedChange={(v) => void updateSettings({ disableClickToDefine: !v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Split lines into words on arrival"
          controlId="dictionary-tokenize"
          description="Otherwise a line is split the first time you point at it."
        >
          <Switch
            id="dictionary-tokenize"
            checked={settings.tokenizeOnArrival}
            onCheckedChange={(v) => void updateSettings({ tokenizeOnArrival: v })}
          />
        </SettingsRow>
        <SettingsRow label="Show furigana" controlId="dictionary-furigana">
          <Switch
            id="dictionary-furigana"
            checked={settings.showFurigana}
            onCheckedChange={(v) => void updateSettings({ showFurigana: v })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Pop-up size">
        <SettingsRow label="Width" controlId="dictionary-pop-w" description="In pixels, 280 to 900.">
          <NumberField
            id="dictionary-pop-w"
            value={settings.popoverWidth}
            min={280}
            max={900}
            step={10}
            fallback={480}
            onCommit={(v) => void updateSettings({ popoverWidth: v })}
          />
        </SettingsRow>
        <SettingsRow label="Height" controlId="dictionary-pop-h" description="In pixels, 200 to 800.">
          <NumberField
            id="dictionary-pop-h"
            value={settings.popoverHeight}
            min={200}
            max={800}
            step={10}
            fallback={360}
            onCommit={(v) => void updateSettings({ popoverHeight: v })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Audio">
        <SettingsRow
          label="Fetch word audio"
          controlId="dictionary-audio"
          description="Pulls audio from the Yomitan API with each lookup."
        >
          <Switch
            id="dictionary-audio"
            checked={settings.audioEnabled}
            onCheckedChange={(v) => {
              if (!v) clearAudioCache()
              void updateSettings({ audioEnabled: v })
            }}
          />
        </SettingsRow>
        {settings.audioEnabled ? (
          <SettingsSubgroup>
            <SettingsRow label="Play on lookup" controlId="dictionary-autoplay">
              <Switch
                id="dictionary-autoplay"
                checked={settings.audioAutoplay}
                onCheckedChange={(v) => void updateSettings({ audioAutoplay: v })}
              />
            </SettingsRow>
            <SettingsRow label="Volume">
              <div className="settings-slider">
                <Slider
                  aria-label="Volume"
                  value={[volume]}
                  min={0}
                  max={100}
                  step={5}
                  onValueChange={(values) => void updateSettings({ audioVolume: values[0] / 100 })}
                />
                <span className="settings-slider-value k-num">{volume}%</span>
              </div>
            </SettingsRow>
          </SettingsSubgroup>
        ) : null}
      </SettingsSection>

      <AnkiSetup settings={settings} />
    </div>
  )
}
