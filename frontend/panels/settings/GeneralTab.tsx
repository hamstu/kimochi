/** Settings → General: appearance and interface size for every Kimochi window. */
import type { ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { Segmented, SettingsPage, SettingsRow, SettingsSection } from '@kit'
import { useSetting } from '../../bridge/useSetting'
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

  return (
    <SettingsPage title="General" description="How Kimochi's windows look on this computer.">
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
    </SettingsPage>
  )
}
