/** Settings → Shortcuts & Controls, first half: global keyboard shortcuts and their gamepad chords. */
import { useCallback, type ReactNode } from 'react'
import { Callout, SettingsRow, SettingsSection, Switch } from '@kit'
import { useHotkeys } from '../../bridge/useHotkeys'
import type { HotkeyName } from '../../bridge/types'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { gamepadChord } from '../../vendor/shared-defaults'
import { formatAccelerator, keyPlatformOf } from './accelerator'
import { useCapabilities } from '../../bridge/capabilities'
import { ShortcutRecorder } from './ShortcutRecorder'

/** Display order. The native side returns the bindings keyed alphabetically. */
const ORDER: HotkeyName[] = ['triggerScan', 'openControllerMenu']

/** Extra guidance under a row, where a binding is easy to get wrong. */
const HINTS: Partial<Record<HotkeyName, string>> = {
  openControllerMenu: "Pick a button combination your game doesn't use."
}

export function ShortcutsSections(): ReactNode {
  const [hotkeys, setHotkeys, hotkeyFailures] = useHotkeys()
  const keyPlatform = keyPlatformOf(useCapabilities())

  const updateHotkeyField = useCallback(
    (
      name: string,
      field: 'accelerator' | 'enabled' | 'gamepadButtons',
      value: string | boolean | number[]
    ): void => {
      const binding = { ...hotkeys[name], [field]: value as never }
      // A chord supersedes the legacy single button, so never store both.
      if (field === 'gamepadButtons') delete binding.gamepadButton
      const updated = { ...hotkeys, [name]: binding }
      void setHotkeys(updated)
    },
    [hotkeys, setHotkeys]
  )

  const entries = ORDER.filter((name) => hotkeys[name]).map(
    (name) => [name, hotkeys[name]] as const
  )

  return (
    <>
      {hotkeyFailures.length > 0 && (
        <Callout tone="danger" className="settings-page-callout">
          {hotkeyFailures.length === 1 ? 'This shortcut' : 'These shortcuts'} could not be
          registered, usually because another application already owns the combination:{' '}
          {hotkeyFailures
            .map(
              (failure) =>
                `${failure.name} (${formatAccelerator(failure.accelerator, keyPlatform)})`
            )
            .join(', ')}
        </Callout>
      )}
      <SettingsSection
        title="Shortcuts"
        description="Work while another app is in front. Each can also have a gamepad button or combination."
      >
        {entries.length === 0 && <SettingsRow label="No hotkeys configured." />}
        {entries.map(([name, def]) => (
          <SettingsRow
            key={name}
            className="shortcut-row"
            label={def.name}
            description={
              HINTS[name] ? (
                <>
                  {def.description}
                  <span className="shortcut-hint">{HINTS[name]}</span>
                </>
              ) : (
                def.description
              )
            }
            controlId={`hotkey-${name}`}
          >
            <ShortcutRecorder
              label={def.name ?? name}
              value={def.accelerator || ''}
              onChange={(accelerator) => updateHotkeyField(name, 'accelerator', accelerator)}
            />
            <GamepadButtonCapture
              chord
              value={gamepadChord(def)}
              onChange={(buttons) => updateHotkeyField(name, 'gamepadButtons', buttons)}
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
    </>
  )
}
