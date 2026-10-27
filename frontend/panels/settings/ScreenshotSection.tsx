/**
 * Settings → Anki → Card enhancement → Screenshot: new cards get the screenshot of the scan their
 * sentence was read in (`cardScreenshot`; src-tauri/src/screenshots.rs). The whole source, or its
 * Anki crop area when the source has one (set from the source's Crop area menu in the main
 * window). The Picture field is found in Anki when it is turned on.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Callout, SettingsRow, SettingsSection, Switch } from '@kit'
import { SETTINGS_DEFAULTS, type CardScreenshotSettings } from '@ui/settings'
import { screenshotStatus } from '@texthooker/lib/screenshots'
import { useSetting } from '../../bridge/useSetting'
import { NumberField } from './fields'
import { FieldInput } from './SentenceAudioSection'
import { useFieldDetection } from './fieldDetection'
import { detectPictureField } from './sentenceAudioField'

const DEFAULTS = SETTINGS_DEFAULTS.cardScreenshot

/** The last card's screenshot, when it failed, checked every few seconds while the section shows. */
function useLastFailure(enabled: boolean): string | null {
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    const check = (): void => {
      screenshotStatus().then(
        (status) => live && setFailure(status.last && !status.last.ok ? status.last.message : null),
        () => {}
      )
    }
    check()
    const timer = window.setInterval(check, 3000)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [enabled])
  return enabled ? failure : null
}

export function ScreenshotSection(): ReactNode {
  const [stored, save] = useSetting<CardScreenshotSettings>('cardScreenshot', DEFAULTS)
  const config = { ...DEFAULTS, ...stored }
  const update = (patch: Partial<CardScreenshotSettings>): void => {
    void save({ ...config, ...patch })
  }
  const detection = useFieldDetection(config.enabled, detectPictureField)
  const failure = useLastFailure(config.enabled)

  return (
    <SettingsSection>
      <SettingsRow
        label="Enhance with screenshot"
        controlId="card-screenshot-enabled"
        description="Kimochi adds a screenshot of your source, taken when the line was scanned, to every new card you make, with any dictionary."
      >
        <Switch
          id="card-screenshot-enabled"
          checked={config.enabled}
          onCheckedChange={(enabled) => {
            update({ enabled })
            if (enabled) detection.run()
          }}
        />
      </SettingsRow>
      {config.enabled && (
        <>
          <div className="settings-note">
            <Callout icon={<Info />}>
              <span>
                Cards get your whole source. To send only part of it, open the source&apos;s{' '}
                <strong>Crop area</strong> menu in the main window and choose{' '}
                <strong>Set Anki crop area</strong>.
              </span>
            </Callout>
          </div>
          {failure && (
            <div className="settings-note">
              <Callout tone="warn">The last card got no screenshot: {failure}</Callout>
            </div>
          )}
          <SettingsRow
            label="Picture field"
            controlId="card-screenshot-field"
            description="The field in your note that gets the screenshot."
          >
            <FieldInput
              id="card-screenshot-field"
              value={config.field}
              placeholder={DEFAULTS.field}
              onSave={(field) => update({ field })}
            />
          </SettingsRow>
          {detection.note && (
            <div className="settings-note">
              <Callout tone="warn">{detection.note}</Callout>
            </div>
          )}
        </>
      )}
      <SettingsRow
        label="Screenshots kept"
        controlId="card-screenshot-kept"
        description="The newest scans' screenshots stay on this computer, to see from the Log and to add to cards you make later."
      >
        <NumberField
          id="card-screenshot-kept"
          value={config.kept}
          min={10}
          max={500}
          step={10}
          fallback={DEFAULTS.kept}
          onCommit={(kept) => update({ kept })}
        />
      </SettingsRow>
    </SettingsSection>
  )
}
