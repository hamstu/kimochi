import { Input, SettingsRow, SettingsSection, SettingsSubgroup, Switch } from '@kit'
import { useSetting } from '../../bridge/useSetting'
import type { Settings } from '../../bridge/settings'
/** Existing Kimochi output bridges remain opt-in; intake no longer depends on either. */
export function OutputSections() {
  const [settings, save] = useSetting<Settings['texthookerSettings']>('texthookerSettings', {
    copyToClipboard: false,
    copyHookedLines: false,
    sendToWebSocket: false,
    sendHookedLines: false,
    webSocketUrl: 'ws://localhost:6677'
  })
  return (
    <SettingsSection title="Output" description="Send OCR scans and hooked lines to other tools.">
      <SettingsRow label="Copy scans to clipboard" controlId="texthooker-out-clipboard">
        <Switch
          id="texthooker-out-clipboard"
          checked={settings.copyToClipboard}
          onCheckedChange={(value) => void save({ ...settings, copyToClipboard: value })}
        />
      </SettingsRow>
      <SettingsRow
        label="Copy hooked lines to clipboard"
        description="Each new line from the Text Hooker, after the Log's line filter and duplicate check."
        controlId="texthooker-out-hook-clipboard"
      >
        <Switch
          id="texthooker-out-hook-clipboard"
          checked={settings.copyHookedLines}
          onCheckedChange={(value) => void save({ ...settings, copyHookedLines: value })}
        />
      </SettingsRow>
      <SettingsRow label="Send scans over WebSocket" controlId="texthooker-out-ws">
        <Switch
          id="texthooker-out-ws"
          checked={settings.sendToWebSocket}
          onCheckedChange={(value) => void save({ ...settings, sendToWebSocket: value })}
        />
      </SettingsRow>
      <SettingsRow
        label="Send hooked lines over WebSocket"
        description="Each new line from the Text Hooker, after the Log's line filter and duplicate check, for a texthooker page in your browser."
        controlId="texthooker-out-hook-ws"
      >
        <Switch
          id="texthooker-out-hook-ws"
          checked={settings.sendHookedLines}
          onCheckedChange={(value) => void save({ ...settings, sendHookedLines: value })}
        />
      </SettingsRow>
      {(settings.sendToWebSocket || settings.sendHookedLines) && (
        <SettingsSubgroup>
          <SettingsRow label="WebSocket URL" controlId="texthooker-out-ws-url">
            <Input
              id="texthooker-out-ws-url"
              mono
              className="settings-field"
              aria-label="WebSocket output URL"
              value={settings.webSocketUrl}
              onChange={(e) => void save({ ...settings, webSocketUrl: e.target.value })}
            />
          </SettingsRow>
        </SettingsSubgroup>
      )}
    </SettingsSection>
  )
}
