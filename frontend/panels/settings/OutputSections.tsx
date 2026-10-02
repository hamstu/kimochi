import { Input, SettingsRow, SettingsSection, SettingsSubgroup, Switch } from "@kit";
import { useSetting } from "../../bridge/useSetting";
import type { TexthookerSettings } from "../../vendor/shared-types";
/** Existing Kimochi output bridges remain opt-in; intake no longer depends on either. */
export function OutputSections() {
  const [settings, save] = useSetting<TexthookerSettings>(
    "texthookerSettings",
    {
      copyToClipboard: false,
      sendToWebSocket: false,
      webSocketUrl: "ws://localhost:6677",
    },
  );
  return (
    <SettingsSection
      title="Output"
      description="Send OCR scans to other tools. These work independently of the input source."
    >
      <SettingsRow label="Copy scans to clipboard" controlId="texthooker-out-clipboard">
        <Switch
          id="texthooker-out-clipboard"
          checked={settings.copyToClipboard}
          onCheckedChange={(value) => void save({ ...settings, copyToClipboard: value })}
        />
      </SettingsRow>
      <SettingsRow label="Send scans over WebSocket" controlId="texthooker-out-ws">
        <Switch
          id="texthooker-out-ws"
          checked={settings.sendToWebSocket}
          onCheckedChange={(value) => void save({ ...settings, sendToWebSocket: value })}
        />
      </SettingsRow>
      {settings.sendToWebSocket && (
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
  );
}
