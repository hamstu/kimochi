/**
 * A keyboard shortcut shown as key caps; click to record a new one. While recording, the next key
 * combination with a modifier (or a function key) is saved, Escape cancels and Backspace / Delete
 * clears the shortcut. Every global shortcut and gamepad action is paused while recording, so a
 * combination that is already bound is captured instead of firing; leaving the window ends it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Kbd } from '@kit'
import {
  acceleratorCaps,
  acceleratorFromEvent,
  formatAccelerator,
  heldModifierCaps,
  isModifierOnly,
  keyPlatformOf
} from './accelerator'
import { useSuspendHotkeys } from '../../bridge/useHotkeys'
import { useCapabilities } from '../../bridge/capabilities'

export function ShortcutRecorder({
  value,
  onChange,
  label
}: {
  value: string
  onChange: (accelerator: string) => void
  /** The shortcut's name, for the accessible label. */
  label: string
}): ReactNode {
  const [recording, setRecording] = useState(false)
  const [held, setHeld] = useState<string[]>([])
  const buttonRef = useRef<HTMLButtonElement>(null)
  const platform = keyPlatformOf(useCapabilities())

  useSuspendHotkeys(recording)

  useEffect(() => {
    if (!recording) return
    buttonRef.current?.focus()
    const stop = (): void => {
      setRecording(false)
      setHeld([])
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        stop()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      if (bare && event.key === 'Escape') return stop()
      if (bare && (event.key === 'Backspace' || event.key === 'Delete')) {
        onChange('')
        return stop()
      }
      if (isModifierOnly(event)) {
        setHeld(heldModifierCaps(event, platform))
        return
      }
      const accelerator = acceleratorFromEvent(event, platform)
      if (accelerator) {
        onChange(accelerator)
        stop()
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (isModifierOnly(event)) setHeld(heldModifierCaps(event, platform))
    }
    const onPointerDown = (event: PointerEvent): void => {
      // `target` can be `window` for a synthetic event from an injected host script.
      const target = event.target
      if (!(target instanceof Node) || !buttonRef.current?.contains(target)) stop()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    const onVisibility = (): void => {
      if (document.hidden) stop()
    }
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', stop)
    }
  }, [recording, onChange, platform])

  const caps = value ? acceleratorCaps(value, platform) : []

  if (!recording && caps.length === 0) {
    return (
      <Button size="sm" aria-label={`Set ${label} shortcut`} onClick={() => setRecording(true)}>
        Set shortcut
      </Button>
    )
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className="shortcut-recorder"
      data-recording={recording ? '' : undefined}
      aria-label={
        recording
          ? `Recording ${label} shortcut. Press keys, Escape to cancel, Delete to clear.`
          : `${label} shortcut: ${formatAccelerator(value, platform)}. Click to change.`
      }
      onClick={() => {
        setHeld([])
        setRecording((on) => !on)
      }}
    >
      {recording ? (
        held.length > 0 ? (
          held.map((cap) => <Kbd key={cap}>{cap}</Kbd>)
        ) : (
          <span className="shortcut-recorder-prompt">Press keys…</span>
        )
      ) : (
        caps.map((cap, index) => <Kbd key={`${cap}-${index}`}>{cap}</Kbd>)
      )}
    </button>
  )
}
