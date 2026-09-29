/**
 * A keyboard shortcut shown as key caps; click to record a new one. While recording, the next key
 * combination with a modifier (or a function key) is saved, Escape cancels and Backspace / Delete
 * clears the shortcut.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Kbd } from '@kit'
import {
  acceleratorCaps,
  acceleratorFromEvent,
  detectKeyPlatform,
  formatAccelerator,
  heldModifierCaps,
  isModifierOnly
} from './accelerator'

const PLATFORM = detectKeyPlatform()

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
        setHeld(heldModifierCaps(event, PLATFORM))
        return
      }
      const accelerator = acceleratorFromEvent(event, PLATFORM)
      if (accelerator) {
        onChange(accelerator)
        stop()
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (isModifierOnly(event)) setHeld(heldModifierCaps(event, PLATFORM))
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!buttonRef.current?.contains(event.target as Node)) stop()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', stop)
    }
  }, [recording, onChange])

  const caps = value ? acceleratorCaps(value, PLATFORM) : []

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
          : `${label} shortcut: ${formatAccelerator(value, PLATFORM)}. Click to change.`
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
