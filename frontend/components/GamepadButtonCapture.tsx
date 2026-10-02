/**
 * COPY of `src/renderer/src/components/GamepadButtonCapture.tsx`.
 * Deltas: `useGamepad` imports from the bridge (same exported shape); rendered with kit buttons.
 * Behaviour: click to capture, press a gamepad button to assign, Escape cancels. Delta: shortcuts
 * and gamepad actions are paused while capturing (the native poller still reports the press, so
 * it can be assigned without firing), and leaving the window cancels the capture.
 */
import { useState, useEffect, useCallback, type JSX } from 'react'
import { Gamepad2, X } from 'lucide-react'
import { Button, IconButton } from '@kit'
import { useGamepad, getButtonName } from '../bridge/useGamepad'
import { useSuspendHotkeys } from '../bridge/useHotkeys'

interface GamepadButtonCaptureProps {
  value?: number
  onChange: (buttonIndex: number | undefined) => void
  disabled?: boolean
  /** '1' is the small control size; '2' and '3' the default. */
  size?: '1' | '2' | '3'
}

export function GamepadButtonCapture({
  value,
  onChange,
  disabled = false,
  size = '2'
}: GamepadButtonCaptureProps): JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const buttonSize = size === '1' ? 'sm' : 'md'

  const handleButtonPress = useCallback(
    (buttonIndex: number) => {
      if (capturing) {
        onChange(buttonIndex)
        setCapturing(false)
      }
    },
    [capturing, onChange]
  )

  const { state, settings } = useGamepad({
    onButtonPress: handleButtonPress
  })

  useSuspendHotkeys(capturing)

  // Cancel capture on escape key, or when the window loses focus or is hidden, so the paused
  // shortcuts never stay paused behind a capture nobody can see.
  useEffect(() => {
    if (!capturing) return

    const cancel = (): void => setCapturing(false)
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
    }
    const handleVisibility = (): void => {
      if (document.hidden) cancel()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [capturing])

  const hasGamepad = state.gamepads.length > 0
  const isDisabled = disabled || !settings.enabled

  const handleStartCapture = (): void => {
    if (!isDisabled && hasGamepad) {
      setCapturing(true)
    }
  }

  const handleClear = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onChange(undefined)
  }

  if (capturing) {
    return (
      <span className="gamepad-capture">
        <Button size={buttonSize} data-capturing="" onClick={() => setCapturing(false)}>
          <Gamepad2 />
          Press a button…
        </Button>
      </span>
    )
  }

  if (!settings.enabled || !hasGamepad) {
    return (
      <span className="gamepad-capture">
        <Button size={buttonSize} disabled>
          <Gamepad2 />
          {!settings.enabled ? 'Disabled' : 'No gamepad'}
        </Button>
      </span>
    )
  }

  if (value !== undefined) {
    return (
      <span className="gamepad-capture">
        <Button size={buttonSize} data-assigned="" onClick={handleStartCapture}>
          <Gamepad2 />
          {getButtonName(value)}
        </Button>
        <IconButton label="Clear gamepad button" size="sm" onClick={handleClear}>
          <X />
        </IconButton>
      </span>
    )
  }

  return (
    <span className="gamepad-capture">
      <Button size={buttonSize} onClick={handleStartCapture} disabled={disabled}>
        <Gamepad2 />
        Set
      </Button>
    </span>
  )
}

export default GamepadButtonCapture
