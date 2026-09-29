/** Settings → Shortcuts: global keyboard shortcuts and their gamepad buttons. */
import { useCallback, type ReactNode } from 'react'
import { Callout, SettingsPage, SettingsRow, SettingsSection, Switch } from '@kit'
import { useHotkeys } from '../../bridge/useHotkeys'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { detectKeyPlatform, formatAccelerator } from './accelerator'
import { ShortcutRecorder } from './ShortcutRecorder'

const KEY_PLATFORM = detectKeyPlatform()

export function ShortcutsTab(): ReactNode {
  const [hotkeys, setHotkeys, hotkeyFailures] = useHotkeys()

  const updateHotkeyField = useCallback(
    (
      name: string,
      field: 'accelerator' | 'enabled' | 'gamepadButton',
      value: string | boolean | number | undefined
    ): void => {
      const updated = {
        ...hotkeys,
        [name]: {
          ...hotkeys[name],
          [field]: value as never
        }
      }
      void setHotkeys(updated)
    },
    [hotkeys, setHotkeys]
  )

  const entries = Object.entries(hotkeys)

  return (
    <SettingsPage
      title="Shortcuts"
      description="Global keyboard shortcuts, each with an optional gamepad button."
    >
      {hotkeyFailures.length > 0 && (
        <Callout tone="danger" className="settings-page-callout">
          {hotkeyFailures.length === 1 ? 'This shortcut' : 'These shortcuts'} could not be registered,
          usually because another application already owns the combination:{' '}
          {hotkeyFailures.map((failure) => `${failure.name} (${formatAccelerator(failure.accelerator, KEY_PLATFORM)})`).join(', ')}
        </Callout>
      )}
      <SettingsSection>
        {entries.length === 0 && <SettingsRow label="No hotkeys configured." />}
        {entries.map(([name, def]) => (
          <SettingsRow key={name} className="shortcut-row" label={def.name} description={def.description} controlId={`hotkey-${name}`}>
            <ShortcutRecorder
              label={def.name ?? name}
              value={def.accelerator || ''}
              onChange={(accelerator) => updateHotkeyField(name, 'accelerator', accelerator)}
            />
            <GamepadButtonCapture
              value={def.gamepadButton}
              onChange={(btn) => updateHotkeyField(name, 'gamepadButton', btn)}
              size="1"
            />
            <Switch
              id={`hotkey-${name}`}
              aria-label={`Enable ${def.name}`}
              checked={def.enabled === true}
              onCheckedChange={(checked) => updateHotkeyField(name, 'enabled', checked)}
            />
          </SettingsRow>
        ))}
      </SettingsSection>
    </SettingsPage>
  )
}
