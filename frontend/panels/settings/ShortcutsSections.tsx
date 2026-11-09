/** Settings → Shortcuts & Controls, first half: global keyboard shortcuts and their gamepad chords. */
import { useCallback, type ReactNode } from 'react'
import { Callout, Select, SettingsRow, SettingsSection, Switch } from '@kit'
import { useHotkeys } from '../../bridge/useHotkeys'
import { useSetting } from '../../bridge/useSetting'
import { showSettingsTab } from './showSettingsTab'
import type { HotkeyName } from '../../bridge/types'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { gamepadChord } from '../../vendor/shared-defaults'
import { formatAccelerator, isMouseAccelerator, keyPlatformOf } from './accelerator'
import { useCapabilities } from '../../bridge/capabilities'
import { ShortcutRecorder } from './ShortcutRecorder'

/** `overlayLookupKey` as the platform's keyboards name it; Command only on a Mac. */
function lookupKeyOptions(mac: boolean): { value: string; label: string }[] {
  return [
    { value: 'shift', label: mac ? '⇧ Shift' : 'Shift' },
    { value: 'ctrl', label: mac ? '⌃ Control' : 'Ctrl' },
    { value: 'alt', label: mac ? '⌥ Option' : 'Alt' },
    ...(mac ? [{ value: 'meta', label: '⌘ Command' }] : [])
  ]
}

/**
 * The key held to look up through the overlay (`overlayLookupKey`). With click-through on, words
 * let clicks through to the game until it is held (native's lookup gate, main.rs); off, they take
 * the mouse anyway and the key does nothing, so the row fades and points at the switch. Only
 * modifiers: the pointer poll reads those globally. Wayland has no global pointer, so no row.
 */
function LookupKeyRow(): ReactNode {
  const capabilities = useCapabilities()
  const mac = capabilities.os === 'macos'
  const [key, setKey] = useSetting<string>('overlayLookupKey', 'shift')
  const [clickThrough] = useSetting<boolean>('overlayClickThrough', true)
  if (capabilities.os === 'linux' && capabilities.session?.backend === 'wayland') return null
  const options = lookupKeyOptions(mac)
  const chosen = options.find((option) => option.value === key) ?? options[0]
  return (
    <>
      <SettingsRow
        label="Lookup key"
        disabled={!clickThrough}
        description={
          clickThrough ? (
            'Hold to look up words on the overlay.'
          ) : (
            <>
              Not needed while{' '}
              <button type="button" className="k-link" onClick={() => showSettingsTab('ocr')}>
                Click through text to the game
              </button>{' '}
              is off.
            </>
          )
        }
      >
        <Select
          aria-label="Lookup key"
          value={chosen.value}
          disabled={!clickThrough}
          onValueChange={(value) => void setKey(value)}
          options={options}
        />
      </SettingsRow>
      {clickThrough && chosen.value !== 'shift' && (
        <div className="settings-note">
          <Callout tone="warn">
            Your dictionary looks words up with Shift by default. Set its lookup key to{' '}
            {chosen.label.replace(/^\S+ /, '')} as well, in its own settings.
          </Callout>
        </div>
      )}
    </>
  )
}

/** Display order. The native side returns the bindings keyed alphabetically. */
const ORDER: HotkeyName[] = ['triggerScan', 'openControllerMenu']

export function ShortcutsSections(): ReactNode {
  const [hotkeys, setHotkeys, hotkeyFailures] = useHotkeys()
  const capabilities = useCapabilities()
  const keyPlatform = keyPlatformOf(capabilities)

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
      {capabilities.os === 'linux' && capabilities.input.globalShortcutRemediation && (
        <Callout tone="warn" className="settings-page-callout">{capabilities.input.globalShortcutRemediation}</Callout>
      )}
      {hotkeyFailures.length > 0 && (
        <Callout tone="danger" className="settings-page-callout">
          {hotkeyFailures.length === 1 ? 'This shortcut' : 'These shortcuts'} could not be
          registered, usually because another application already owns the combination:{' '}
          {hotkeyFailures
            .map((failure) =>
              // A mouse button fails for its own reason (no hook here, or no Accessibility).
              isMouseAccelerator(failure.accelerator ?? '')
                ? `${failure.name} (${formatAccelerator(failure.accelerator, keyPlatform)}: ${failure.error})`
                : `${failure.name} (${formatAccelerator(failure.accelerator, keyPlatform)})`
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
            description={def.description}
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
        <LookupKeyRow />
      </SettingsSection>
    </>
  )
}
