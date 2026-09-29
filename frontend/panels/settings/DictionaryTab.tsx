/** Settings → Dictionary: which lookup pop-up to use, and where its settings or API live. */
import { useCallback, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  Input,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  StatusDot,
  type Tone
} from '@kit'
import type { PopupType, YomitanSettings } from '../../vendor/shared-types'
import { API_URLS } from '../../vendor/shared-constants'
import { useSetting } from '../../bridge/useSetting'
import { nativeError, panel } from '../../bridge/tauri'
import { describeUrlRestriction, testApiConnection } from '../../bridge/yomitan'

type TestStatus = 'idle' | 'testing' | 'success' | 'error'

const POPUP_OPTIONS = [
  { value: 'builtin', label: 'Built-in Yomitan' },
  { value: 'custom-api', label: 'Custom (Yomitan API)', detail: <Badge tone="warn">Experimental</Badge> }
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
      <SettingsSection>
        <SettingsRow
          label="Pop-up type"
          badge={yomitanSettings.popupType === 'custom-api' ? <Badge tone="warn">Experimental</Badge> : undefined}
        >
          <Select
            aria-label="Pop-up type"
            value={yomitanSettings.popupType}
            onValueChange={(value) => handlePopupTypeChange(value)}
            options={POPUP_OPTIONS}
          />
        </SettingsRow>

        {yomitanSettings.popupType === 'builtin' && (
          <SettingsRow
            label="Yomitan settings"
            description="Dictionaries, import and scanning options, in Yomitan's own settings window."
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
    </SettingsPage>
  )
}
