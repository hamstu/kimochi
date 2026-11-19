/**
 * One global shortcut's row (`hotkeys[name]`): its keys, its gamepad button or combination, and
 * whether it is on. Settings → Shortcuts & Controls lists them; Settings → Overlay → Radial menu
 * shows the radial menu's own.
 */
import { useCallback, type ReactNode } from 'react'
import { SettingsRow, Switch } from '@kit'
import { useHotkeys } from '../../bridge/useHotkeys'
import type { HotkeyName } from '../../bridge/types'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { gamepadChord } from '../../vendor/shared-defaults'
import { ShortcutRecorder } from './ShortcutRecorder'

export function HotkeyRow({ name }: { name: HotkeyName }): ReactNode {
  const [hotkeys, setHotkeys] = useHotkeys()
  const update = useCallback(
    (field: 'accelerator' | 'enabled' | 'gamepadButtons', value: string | boolean | number[]): void => {
      const binding = { ...hotkeys[name], [field]: value as never }
      // A chord supersedes the legacy single button, so never store both.
      if (field === 'gamepadButtons') delete binding.gamepadButton
      void setHotkeys({ ...hotkeys, [name]: binding })
    },
    [hotkeys, name, setHotkeys]
  )
  const def = hotkeys[name]
  if (!def) return null
  return (
    <SettingsRow className="shortcut-row" label={def.name} description={def.description} controlId={`hotkey-${name}`}>
      <ShortcutRecorder
        label={def.name ?? name}
        value={def.accelerator || ''}
        onChange={(accelerator) => update('accelerator', accelerator)}
      />
      <GamepadButtonCapture
        chord
        value={gamepadChord(def)}
        onChange={(buttons) => update('gamepadButtons', buttons)}
        size="1"
      />
      <Switch
        id={`hotkey-${name}`}
        aria-label={`Enable ${def.name}`}
        checked={def.enabled === true}
        onCheckedChange={(checked) => update('enabled', checked)}
      />
    </SettingsRow>
  )
}
