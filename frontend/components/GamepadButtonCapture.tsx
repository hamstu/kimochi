/**
 * COPY of `src/renderer/src/components/GamepadButtonCapture.tsx`.
 * Delta: `useGamepad` imports from the bridge (same exported shape). Markup unchanged.
 */
import { useState, useEffect, useCallback, type JSX } from 'react'
import { Button, Flex, Text } from '@radix-ui/themes'
import { Gamepad2, X } from 'lucide-react'
import { useGamepad, getButtonName } from '../bridge/useGamepad'

interface GamepadButtonCaptureProps {
  value?: number
  onChange: (buttonIndex: number | undefined) => void
  disabled?: boolean
  size?: '1' | '2' | '3'
}

export function GamepadButtonCapture({
  value,
  onChange,
  disabled = false,
  size = '2'
}: GamepadButtonCaptureProps): JSX.Element {
  const [capturing, setCapturing] = useState(false)

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

  // Cancel capture on escape key
  useEffect(() => {
    if (!capturing) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setCapturing(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
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

  // Show different states
  if (capturing) {
    return (
      <Button size={size} variant="soft" color="blue" onClick={() => setCapturing(false)}>
        <Gamepad2 size={14} />
        <Text size="1">Press button...</Text>
      </Button>
    )
  }

  if (!settings.enabled) {
    return (
      <Button size={size} variant="soft" color="gray" disabled>
        <Gamepad2 size={14} />
        <Text size="1">Disabled</Text>
      </Button>
    )
  }

  if (!hasGamepad) {
    return (
      <Button size={size} variant="soft" color="gray" disabled>
        <Gamepad2 size={14} />
        <Text size="1">No gamepad</Text>
      </Button>
    )
  }

  if (value !== undefined) {
    return (
      <Flex align="center" gap="1">
        <Button size={size} variant="soft" color="green" onClick={handleStartCapture}>
          <Gamepad2 size={14} />
          <Text size="1">{getButtonName(value)}</Text>
        </Button>
        <Button size={size} variant="ghost" color="gray" onClick={handleClear}>
          <X size={12} />
        </Button>
      </Flex>
    )
  }

  return (
    <Button size={size} variant="soft" color="gray" onClick={handleStartCapture}>
      <Gamepad2 size={14} />
      <Text size="1">Set</Text>
    </Button>
  )
}

export default GamepadButtonCapture
