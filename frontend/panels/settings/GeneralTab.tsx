/** Settings → General: appearance and interface size for every Kimochi window, sound effects, desktop integration (GNOME, the Steam library) and the welcome guide. Updates are on About. */
import { GnomeOverlaySetup } from '../../main/GnomeOverlaySetup'
import { SteamLibrarySection } from './SteamLibrarySection'
import type { ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { Button, Segmented, SettingsPage, SettingsRow, SettingsSection, SettingsSubgroup, Switch } from '@kit'
import { useController } from '../useController'
import { panel } from '../../bridge/tauri'
import { useSetting } from '../../bridge/useSetting'
import { useCapabilities } from '../../bridge/capabilities'
import { INTERFACE_SCALES, type Appearance, type InterfaceScale } from '@ui/settings'

const APPEARANCES = [
  { value: 'system', label: 'System', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> }
] as const

const SCALES = (Object.keys(INTERFACE_SCALES) as InterfaceScale[]).map((value) => ({
  value,
  label: INTERFACE_SCALES[value].label.replace('Extra large', 'XL')
}))

export function GeneralTab(): ReactNode {
  const [appearance, setAppearance] = useSetting<Appearance>('appearance', 'system')
  const [scale, setScale] = useSetting<InterfaceScale>('interfaceScale', 'medium')
  const [soundEffects, setSoundEffects] = useSetting<boolean>('soundEffects', true)
  const [scanSounds, setScanSounds] = useSetting<boolean>('soundEffectsScans', true)
  const [clickSounds, setClickSounds] = useSetting<boolean>('soundEffectsClicks', true)
  const { props: controller } = useController()
  const { capture } = useCapabilities()
  // Screen recording is a step only where it is granted in the system's settings.
  const grantsCapture = capture.authorization === 'granted' || capture.authorization === 'denied'

  return (
    <SettingsPage title="General" description="How Kimochi looks on this computer.">
      <SettingsSection title="Appearance">
        <SettingsRow
          label="Theme"
          description={
            appearance === 'system'
              ? 'Follows your system setting.'
              : `Always ${appearance}, whatever the system uses.`
          }
        >
          <Segmented
            aria-label="Theme"
            value={appearance}
            onValueChange={(value) => void setAppearance(value)}
            options={APPEARANCES}
          />
        </SettingsRow>
        <SettingsRow
          label="Interface size"
          description="Scales text, spacing and controls in every window. Transcript text keeps its own size."
        >
          <Segmented
            aria-label="Interface size"
            value={scale}
            onValueChange={(value) => void setScale(value)}
            options={SCALES}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Sound">
        <SettingsRow
          label="Sound effects"
          controlId="general-sound-effects"
          description="Turns every sound on or off. The speaker in each title bar does the same."
        >
          <Switch
            id="general-sound-effects"
            checked={soundEffects}
            onCheckedChange={(checked) => void setSoundEffects(checked)}
          />
        </SettingsRow>
        {soundEffects && (
          <SettingsSubgroup>
            <SettingsRow
              label="Scan sounds"
              controlId="general-sound-scans"
              description="When a scan starts, adds lines to the Log or fails."
            >
              <Switch
                id="general-sound-scans"
                checked={scanSounds}
                onCheckedChange={(checked) => void setScanSounds(checked)}
              />
            </SettingsRow>
            <SettingsRow
              label="Click sounds"
              controlId="general-sound-clicks"
              description="When you click buttons, switches and menus."
            >
              <Switch
                id="general-sound-clicks"
                checked={clickSounds}
                onCheckedChange={(checked) => void setClickSounds(checked)}
              />
            </SettingsRow>
          </SettingsSubgroup>
        )}
      </SettingsSection>
      <SettingsSection title="Diagnostics">
        <SettingsRow
          label="Debug overlay"
          controlId="general-debug"
          description="Marks the scanned text boxes over the source and opens the Diagnostics window."
        >
          <Switch
            id="general-debug"
            checked={controller.showDebugOverlay}
            onCheckedChange={() => controller.onToggleDebugOverlay()}
          />
        </SettingsRow>
      </SettingsSection>
      <GnomeOverlaySetup settings />
      <SteamLibrarySection />
      <SettingsSection title="Help">
        <SettingsRow
          label="Welcome guide"
          description={
            grantsCapture
              ? 'The first-run walkthrough: capture permission, OCR, dictionaries and reading basics.'
              : 'The first-run walkthrough: OCR, dictionaries and reading basics.'
          }
        >
          <Button size="sm" onClick={() => void panel('welcome', 'show').catch(() => undefined)}>
            Open
          </Button>
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  )
}
