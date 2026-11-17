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
import { ShortcutChip } from './ShortcutChip'
import { useGamepad, getButtonName } from '../bridge/useGamepad'
import { usePadLayout } from '../bridge/usePadLayout'
import { PadText } from './PadText'
import { useSuspendHotkeys } from '../bridge/useHotkeys'

interface CommonProps {
  disabled?: boolean
  /** Kept for callers; every size draws the same ShortcutChip now. */
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
  return buttons.map((button) => getButtonName(button)).join(' + ')
}

function commit(props: GamepadButtonCaptureProps, buttons: number[]): void {
  if (props.chord) props.onChange(buttons)
  else props.onChange(buttons[0])
}

export function GamepadButtonCapture(props: GamepadButtonCaptureProps): JSX.Element {
  const { disabled = false } = props
  const [capturing, setCapturing] = useState(false)
  usePadLayout()
  // The combination so far, for display; the refs are what the gamepad callbacks read, since
  // a press and a release can both arrive before the next render.
  const [collected, setCollected] = useState<number[]>([])
  const collectedRef = useRef<number[]>([])
  const heldRef = useRef<Set<number>>(new Set())

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
  const assigned = props.chord ? (props.value ?? []) : props.value !== undefined ? [props.value] : []

  const handleStartCapture = (): void => {
    if (!isDisabled && hasGamepad) {
      heldRef.current = new Set()
      collectedRef.current = []
      setCollected([])
      setCapturing(true)
    }
  }

  const clear = (): void => commit(props, [])
  const clearLabel = props.chord ? 'Clear gamepad buttons' : 'Clear gamepad button'

  if (capturing) {
    const prompt = props.chord ? 'Press a combination…' : 'Press a button…'
    return (
      <ShortcutChip
        kind="pad"
        state="recording"
        label={`${prompt} Escape to cancel.`}
        onPress={() => setCapturing(false)}
      >
        {collected.length > 0 ? (
          <PadText text={`${formatChord(collected)}…`} />
        ) : (
          <span className="shortcut-chip-prompt">{prompt}</span>
        )}
      </ShortcutChip>
    )
  }

  if (!settings.enabled || !hasGamepad) {
    // A saved binding stays visible (and clearable) while the controller is unplugged or gamepad
    // support is off, so what was set is never hidden.
    const showAssigned = assigned.length > 0
    const reason = !settings.enabled ? 'Gamepad support is off' : 'No gamepad connected'
    return (
      <ShortcutChip
        kind="pad"
        state={showAssigned ? 'set' : 'empty'}
        disabled
        title={reason}
        label={showAssigned ? `Gamepad: ${formatChord(assigned)}. ${reason}.` : reason}
        onPress={() => undefined}
        onClear={showAssigned ? clear : undefined}
        clearLabel={clearLabel}
      >
        {showAssigned ? <PadText text={formatChord(assigned)} /> : !settings.enabled ? 'Disabled' : 'No gamepad'}
      </ShortcutChip>
    )
  }

  if (assigned.length > 0) {
    return (
      <ShortcutChip
        kind="pad"
        state="set"
        label={`Gamepad: ${formatChord(assigned)}. Click to change.`}
        onPress={handleStartCapture}
        onClear={clear}
        clearLabel={clearLabel}
      >
        <PadText text={formatChord(assigned)} />
      </ShortcutChip>
    )
  }

  return (
    <ShortcutChip kind="pad" state="empty" label="Set gamepad button" onPress={handleStartCapture} disabled={disabled}>
      Set
    </ShortcutChip>
  )
}

export default GamepadButtonCapture
