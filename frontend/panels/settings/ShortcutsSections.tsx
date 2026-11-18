/** Settings → Shortcuts & Controls, first half: global keyboard shortcuts and their gamepad chords. */
import { useCallback, type ReactNode } from 'react'
import { Badge, Callout, SettingsRow, SettingsSection, Switch } from '@kit'
import { useHotkeys } from '../../bridge/useHotkeys'
import { useSetting } from '../../bridge/useSetting'
import { clickThroughLocked } from '@ui/settings'
import { showSettingsTab } from './showSettingsTab'
import type { HotkeyName } from '../../bridge/types'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { gamepadChord } from '../../vendor/shared-defaults'
import { formatAccelerator, isMouseAccelerator, keyPlatformOf } from './accelerator'
import { useCapabilities } from '../../bridge/capabilities'
import { ShortcutRecorder } from './ShortcutRecorder'
import { LookupKeyRecorder } from './LookupKeyRecorder'
import {
  effectiveLookupKey,
  isLookupButton,
  lookupKeyWord,
  lookupModifier,
  type LookupButtonSupport
} from '@ui/lookup-key'

/** Where the lookup key's click goes, when it is a mouse button (`keys.lookupButtons`). */
const BUTTON_NOTES: Partial<Record<LookupButtonSupport, ReactNode>> = {
  needsAccessibility: (
    <>
      Its click also reaches the game. Allow Accessibility in{' '}
      <button type="button" className="k-link" onClick={() => showSettingsTab('sources')}>
        Sources
      </button>{' '}
      to keep clicks on the overlay&rsquo;s text from the game.
    </>
  ),
  passthrough: 'On Linux its click also reaches the game, so pick a button the game doesn’t use.'
}

/**
 * The key held to look up through the overlay (`overlayLookupKey`): a modifier, or a mouse button
 * (middle, back, forward; #204) where native can read one (`keys.lookupButtons`). With
 * click-through on, words let clicks through to the game until it is held (native's lookup gate,
 * main.rs); off, they take the mouse anyway and the key does nothing, so the row fades and points
 * at the switch. On Wayland only KDE Plasma's source reads every modifier (Hyprland relays Shift
 * alone), so elsewhere there is no row.
 */
function LookupKeyRow(): ReactNode {
  const capabilities = useCapabilities()
  const mac = capabilities.os === 'macos'
  const support = capabilities.keys.lookupButtons ?? 'unsupported'
  const [stored, setKey] = useSetting<string>('overlayLookupKey', 'shift')
  const [storedClickThrough] = useSetting<boolean>('overlayClickThrough', true)
  const [overlayStyle] = useSetting<unknown>('overlayStyle', null)
  // Text drawn Transparent always lets clicks through (`clickThroughLocked`).
  const clickThrough = storedClickThrough !== false || clickThroughLocked(overlayStyle, 'words')
  const [hover] = useSetting<boolean>('overlayHoverLookup', false)
  const [hotkeys] = useHotkeys()
  // Wayland: only where the pointer poll reads every modifier (KDE Plasma, through XWayland).
  if (
    capabilities.os === 'linux' &&
    capabilities.session?.backend === 'wayland' &&
    capabilities.overlay.shiftSource !== 'xwayland'
  )
    return null
  const key = effectiveLookupKey(stored, support)
  const button = isLookupButton(key)
  // A shortcut on the same button does not fire while it is the lookup key (native reads the
  // lookup key first).
  const shared = button
    ? Object.values(hotkeys)
        .filter((hotkey) => hotkey.enabled !== false && hotkey.accelerator?.toLowerCase() === key.toLowerCase())
        .map((hotkey) => hotkey.name)
    : []
  const note = button ? BUTTON_NOTES[support] : undefined
  return (
    <>
      <SettingsRow
        label="Lookup key"
        disabled={!clickThrough}
        badge={shared.length > 0 ? <Badge tone="warn">Same as {shared.join(', ')}</Badge> : undefined}
        description={
          clickThrough ? (
            hover ? (
              'Hold to click text on the overlay, or to look a word up at once.'
            ) : (
              `Hold to look up words on the overlay. A key${support === 'unsupported' ? '' : ' or a mouse button'}.`
            )
          ) : (
            <>
              Not needed while{' '}
              <button type="button" className="k-link" onClick={() => showSettingsTab('overlay')}>
                Click through text to the game
              </button>{' '}
              is off.
            </>
          )
        }
      >
        <LookupKeyRecorder
          value={key}
          onChange={(next) => void setKey(next)}
          mac={mac}
          support={support}
          disabled={!clickThrough}
        />
      </SettingsRow>
      {clickThrough && shared.length > 0 && (
        <div className="settings-note">
          <Callout tone="warn">
            {shared.join(', ')} {shared.length === 1 ? 'is' : 'are'} set to the same button and won&rsquo;t run while
            it&rsquo;s the lookup key.
          </Callout>
        </div>
      )}
      {clickThrough && note && (
        <div className="settings-note">
          <Callout tone="neutral">{note}</Callout>
        </div>
      )}
      {clickThrough && lookupModifier(key) !== 'shift' && (
        <div className="settings-note">
          <Callout tone="warn">
            Your dictionary looks words up with Shift by default. Set its lookup key to {lookupKeyWord(key, mac)} as
            well, in its own settings.
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
    (name: string, field: 'accelerator' | 'enabled' | 'gamepadButtons', value: string | boolean | number[]): void => {
      const binding = { ...hotkeys[name], [field]: value as never }
      // A chord supersedes the legacy single button, so never store both.
      if (field === 'gamepadButtons') delete binding.gamepadButton
      const updated = { ...hotkeys, [name]: binding }
      void setHotkeys(updated)
    },
    [hotkeys, setHotkeys]
  )

  const entries = ORDER.filter((name) => hotkeys[name]).map((name) => [name, hotkeys[name]] as const)

  return (
    <>
      {capabilities.os === 'linux' && capabilities.input.globalShortcutRemediation && (
        <Callout tone="warn" className="settings-page-callout">
          {capabilities.input.globalShortcutRemediation}
        </Callout>
      )}
      {hotkeyFailures.length > 0 && (
        <Callout tone="danger" className="settings-page-callout">
          {hotkeyFailures.length === 1 ? 'This shortcut' : 'These shortcuts'} could not be registered, usually because
          another application already owns the combination:{' '}
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
