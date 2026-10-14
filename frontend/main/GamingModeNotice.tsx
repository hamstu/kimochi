import { useState, type JSX } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button, Callout, Kbd } from '@kit'
import { useCapabilities } from '../bridge/capabilities'
import { useHotkeys } from '../bridge/useHotkeys'
import { getButtonName } from '../bridge/useGamepad'
import { formatAccelerator, keyPlatformOf } from '../panels/settings/accelerator'

/** Game-return affordance stays visible even when the source sidebar is closed. */
export function GamingModeNotice(): JSX.Element | null {
  const capabilities = useCapabilities()
  const [hotkeys] = useHotkeys()
  const [error, setError] = useState<string | null>(null)
  if (capabilities.os !== 'linux' || capabilities.session?.compositor?.toLowerCase() !== 'gamescope') return null
  const binding = hotkeys.openControllerMenu
  const enabled = binding?.enabled !== false
  const buttons = enabled ? (binding?.gamepadButtons ?? (Number.isInteger(binding?.gamepadButton) ? [binding.gamepadButton as number] : [])) : []
  const keyboard = enabled ? formatAccelerator(binding?.accelerator ?? '', keyPlatformOf(capabilities)) : ''
  const leave = async (): Promise<void> => {
    try { await invoke('return_to_game'); setError(null) }
    catch (caught) { setError(String(caught)) }
  }
  return <Callout className="gaming-mode-notice">
    <div className="gaming-mode-notice-row">
      <span><strong>Gaming Mode</strong> · {buttons.length > 0 || keyboard ? <>
        Press {buttons.map((button, index) => <span key={button} className="gaming-mode-chord">{index > 0 && ' + '}<Kbd>{getButtonName(button)}</Kbd></span>)}
        {buttons.length > 0 && keyboard && ' or '}{keyboard && <Kbd>{keyboard}</Kbd>} for the game menu.
      </> : 'Return to your game when you’re ready.'}</span>
      <Button size="sm" onClick={() => void leave()}>Return to game</Button>
    </div>
    {error && <span role="alert">{error}</span>}
  </Callout>
}
