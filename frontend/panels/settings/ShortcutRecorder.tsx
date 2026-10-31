/**
 * A keyboard shortcut shown as key caps; click to record a new one. While recording, the next key
 * combination with a modifier (or a key that can stand alone: a function key, Insert, Pause or
 * Scroll Lock, `standsAlone` in accelerator.ts) is saved, Escape cancels and Backspace / Delete
 * clears the shortcut. Where native can catch them (`keys.mouseButtons`), a middle, back or
 * forward click is saved too; elsewhere the recorder says why it was not. Every global shortcut,
 * bound mouse button and gamepad action is paused while recording, so a binding that is already
 * in use is captured instead of firing; leaving the window ends it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Kbd } from '@kit'
import {
  acceleratorCaps,
  acceleratorFromEvent,
  formatAccelerator,
  heldModifierCaps,
  isModifierOnly,
  keyPlatformOf,
  mouseButtonAccelerator
} from './accelerator'
import { useSuspendHotkeys } from '../../bridge/useHotkeys'
import { useCapabilities } from '../../bridge/capabilities'
import { accessibilityStatus } from '../../bridge/tauri'

const MOUSE_NOTICES = {
  needsAccessibility: 'Mouse buttons need Accessibility (Settings → Sources)',
  unsupported: "Mouse buttons can't be shortcuts here"
} as const

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
  const [notice, setNotice] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const capabilities = useCapabilities()
  const platform = keyPlatformOf(capabilities)
  const mouseButtons = capabilities.keys.mouseButtons

  useSuspendHotkeys(recording)

  useEffect(() => {
    if (!recording) return
    buttonRef.current?.focus()
    const stop = (): void => {
      setRecording(false)
      setHeld([])
      setNotice(null)
    }
    // Recorded on release, with press and release both kept from the page, so a back or forward
    // click cannot navigate the Settings window and a middle click cannot start autoscroll.
    const onMouseDown = (event: MouseEvent): void => {
      if (mouseButtonAccelerator(event.button) === null) return
      event.preventDefault()
      event.stopPropagation()
    }
    const onMouseUp = (event: MouseEvent): void => {
      const accelerator = mouseButtonAccelerator(event.button)
      if (accelerator === null) return
      event.preventDefault()
      event.stopPropagation()
      const accept = (): void => {
        onChange(accelerator)
        stop()
      }
      if (mouseButtons === 'available') return accept()
      setNotice(MOUSE_NOTICES[mouseButtons === 'needsAccessibility' ? 'needsAccessibility' : 'unsupported'])
      // Accessibility may have been allowed since the capabilities were read.
      if (mouseButtons === 'needsAccessibility') {
        void accessibilityStatus()
          .then((granted) => {
            if (granted) accept()
          })
          .catch(() => undefined)
      }
    }
    const onAuxClick = (event: MouseEvent): void => {
      if (mouseButtonAccelerator(event.button) === null) return
      event.preventDefault()
      event.stopPropagation()
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
      if (mouseButtonAccelerator(event.button) !== null) return
      // `target` can be `window` for a synthetic event from an injected host script.
      const target = event.target
      if (!(target instanceof Node) || !buttonRef.current?.contains(target)) stop()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('auxclick', onAuxClick, true)
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
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mouseup', onMouseUp, true)
      window.removeEventListener('auxclick', onAuxClick, true)
      window.removeEventListener('blur', stop)
    }
  }, [recording, onChange, platform, mouseButtons])

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
          ? `Recording ${label} shortcut. Press keys${mouseButtons === 'available' ? ' or a mouse button' : ''}, Escape to cancel, Delete to clear.`
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
          <span className="shortcut-recorder-prompt">{notice ?? 'Press keys…'}</span>
        )
      ) : (
        caps.map((cap, index) => <Kbd key={`${cap}-${index}`}>{cap}</Kbd>)
      )}
    </button>
  )
}
