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
import { isGamingMode, useCapabilities } from '../../bridge/capabilities'
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
 * modifiers: the pointer poll reads those globally. On Wayland only KDE Plasma's source reads them
 * all (Hyprland relays Shift alone), so elsewhere there no row.
 */
function LookupKeyRow(): ReactNode {
  const capabilities = useCapabilities()
  const mac = capabilities.os === 'macos'
  const [key, setKey] = useSetting<string>('overlayLookupKey', 'shift')
  const [clickThrough] = useSetting<boolean>('overlayClickThrough', true)
  const [hover] = useSetting<boolean>('overlayHoverLookup', false)
  // Wayland: only where the pointer poll reads every modifier (KDE Plasma, through XWayland).
  if (capabilities.os === 'linux' && capabilities.session?.backend === 'wayland' &&
    capabilities.overlay.shiftSource !== 'xwayland') return null
  const options = lookupKeyOptions(mac)
  const chosen = options.find((option) => option.value === key) ?? options[0]
  return (
    <>
      <SettingsRow
        label="Lookup key"
        disabled={!clickThrough}
        description={
          clickThrough ? (
            hover ? 'Hold to click text on the overlay, or to look a word up at once.' : 'Hold to look up words on the overlay.'
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

/**
 * Look up on hover (`overlayHoverLookup`): resting the pointer on a word on the overlay looks it
 * up with no key held. Lookups only: the words keep letting clicks through to the game unless the
 * lookup key is held, so nothing here takes the mouse from it. Native decides when the pointer
 * rests rather than passes by (`state::HoverIntent`). Not on Wayland, where the pointer is read
 * only while the key is held, nor in Gaming Mode.
 */
function HoverLookupRow(): ReactNode {
  const capabilities = useCapabilities()
  const [hover, setHover] = useSetting<boolean>('overlayHoverLookup', false)
  // Gaming Mode has no pointer to rest; the controller reads words there.
  if (isGamingMode(capabilities)) return null
  if (capabilities.os === 'linux' && capabilities.session?.backend === 'wayland') return null
  return (
    <SettingsRow
      label="Look up on hover"
      controlId="overlay-hover-lookup"
      description="Rest the pointer on a word on the overlay to look it up, no key needed."
    >
      <Switch id="overlay-hover-lookup" checked={hover} onCheckedChange={(checked) => void setHover(checked)} />
    </SettingsRow>
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
        <HoverLookupRow />
      </SettingsSection>
    </>
  )
}
