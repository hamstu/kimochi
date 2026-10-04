/**
 * COPY of `src/renderer/src/components/GamepadButtonCapture.tsx`.
 * Deltas: `useGamepad` imports from the bridge (same exported shape); rendered with kit buttons.
 * Behaviour: click to capture, press a gamepad button to assign, Escape cancels. Delta: shortcuts
 * and gamepad actions are paused while capturing (the native poller still reports the press, so
 * it can be assigned without firing), and leaving the window cancels the capture.
 *
 * Delta: `chord` mode captures a combination. Every button pressed while any is held joins it,
 * and it is committed (sorted) once they are all released. Without `chord` the value stays a
 * single button index, which is what the auto-scan trigger stores.
 */
import { useState, useEffect, useCallback, useRef, type JSX } from 'react'
import { Gamepad2, X } from 'lucide-react'
import { Button, IconButton } from '@kit'
import { useGamepad, getButtonName } from '../bridge/useGamepad'
import { useSuspendHotkeys } from '../bridge/useHotkeys'

interface CommonProps {
  disabled?: boolean
  /** '1' is the small control size; '2' and '3' the default. */
  size?: '1' | '2' | '3'
}

interface SingleProps extends CommonProps {
  chord?: false
  value?: number
  onChange: (buttonIndex: number | undefined) => void
}

interface ChordProps extends CommonProps {
  chord: true
  value?: number[]
  /** An empty array clears the binding. */
  onChange: (buttons: number[]) => void
}

type GamepadButtonCaptureProps = SingleProps | ChordProps

/** "LS + RS", using the standard button names. */
function formatChord(buttons: number[]): string {
  return buttons.map(getButtonName).join(' + ')
}

function commit(props: GamepadButtonCaptureProps, buttons: number[]): void {
  if (props.chord) props.onChange(buttons)
  else props.onChange(buttons[0])
}

export function GamepadButtonCapture(props: GamepadButtonCaptureProps): JSX.Element {
  const { disabled = false, size = '2' } = props
  const [capturing, setCapturing] = useState(false)
  // The combination so far, for display; the refs are what the gamepad callbacks read, since
  // a press and a release can both arrive before the next render.
  const [collected, setCollected] = useState<number[]>([])
  const collectedRef = useRef<number[]>([])
  const heldRef = useRef<Set<number>>(new Set())
  const buttonSize = size === '1' ? 'sm' : 'md'

  const handleButtonPress = useCallback(
    (buttonIndex: number) => {
      if (!capturing) return
      if (!props.chord) {
        commit(props, [buttonIndex])
        setCapturing(false)
        return
      }
      heldRef.current.add(buttonIndex)
      if (!collectedRef.current.includes(buttonIndex)) {
        collectedRef.current = [...collectedRef.current, buttonIndex].sort((a, b) => a - b)
        setCollected(collectedRef.current)
      }
    },
    [capturing, props]
  )

  const handleButtonRelease = useCallback(
    (buttonIndex: number) => {
      if (!capturing || !props.chord) return
      // A button already down when capture started is not part of the combination.
      if (!heldRef.current.delete(buttonIndex)) return
      if (heldRef.current.size > 0 || collectedRef.current.length === 0) return
      commit(props, collectedRef.current)
      setCapturing(false)
    },
    [capturing, props]
  )

  const { state, settings } = useGamepad({
    onButtonPress: handleButtonPress,
    onButtonRelease: handleButtonRelease
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
  const assigned = props.chord
    ? (props.value ?? [])
    : props.value !== undefined
      ? [props.value]
      : []

  const handleStartCapture = (): void => {
    if (!isDisabled && hasGamepad) {
      heldRef.current = new Set()
      collectedRef.current = []
      setCollected([])
      setCapturing(true)
    }
  }

  const handleClear = (e: React.MouseEvent): void => {
    e.stopPropagation()
    commit(props, [])
  }

  if (capturing) {
    const prompt = props.chord ? 'Press a combination…' : 'Press a button…'
    return (
      <span className="gamepad-capture">
        <Button size={buttonSize} data-capturing="" onClick={() => setCapturing(false)}>
          <Gamepad2 />
          {collected.length > 0 ? `${formatChord(collected)}…` : prompt}
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

  if (assigned.length > 0) {
    return (
      <span className="gamepad-capture">
        <Button size={buttonSize} data-assigned="" onClick={handleStartCapture}>
          <Gamepad2 />
          {formatChord(assigned)}
        </Button>
        <IconButton
          label={props.chord ? 'Clear gamepad buttons' : 'Clear gamepad button'}
          size="sm"
          onClick={handleClear}
        >
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
