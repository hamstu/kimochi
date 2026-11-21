/**
 * The overlay's lookup key (`overlayLookupKey`) as one ShortcutChip, like the shortcuts above it:
 * click, then press a modifier (Shift, Ctrl, Alt; ⌘ on a Mac) or a mouse button (middle, back,
 * forward) to make it the key held to look words up. Escape cancels. There is always a lookup
 * key, so there is no ×.
 *
 * Beside it, a ▾ menu sets the key from a list (#275): the same choices, picked rather than
 * pressed, for a button the recorder never hears in full (mouse software that keeps the middle
 * button's release from the window, so the press shows and nothing is taken). The current key is
 * ticked; there is no clearing it there either.
 *
 * Mouse buttons only where native can read them (`keys.lookupButtons`, ui/lookup-key.ts); on
 * Wayland the recorder says why one was not taken. Shortcuts and bound mouse buttons are paused
 * while recording, so a button that is also a shortcut is recorded instead of firing.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { IconButton, Kbd, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@kit'
import { ShortcutChip } from '../../components/ShortcutChip'
import { useSuspendHotkeys } from '../../bridge/useHotkeys'
import {
  isLookupButton,
  lookupButtonFromEvent,
  lookupKeyChoices,
  lookupKeyLabel,
  lookupModifierFromKey,
  type LookupButtonSupport,
  type LookupKey
} from '@ui/lookup-key'

export function LookupKeyRecorder({
  value,
  onChange,
  mac,
  support,
  disabled = false
}: {
  /** The effective key (`effectiveLookupKey`): a button where none can be read is Shift. */
  value: LookupKey
  onChange: (key: LookupKey) => void
  mac: boolean
  support: LookupButtonSupport
  disabled?: boolean
}): ReactNode {
  const [recording, setRecording] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const buttons = support !== 'unsupported'

  useSuspendHotkeys(recording)

  useEffect(() => {
    if (!recording) return
    buttonRef.current?.focus()
    const stop = (): void => {
      setRecording(false)
      setNotice(null)
    }
    const accept = (key: LookupKey): void => {
      onChange(key)
      stop()
    }
    // A mouse button is taken on release, its press and release both kept from the page, so back
    // and forward cannot navigate the Settings window and a middle click cannot start autoscroll.
    const swallow = (event: MouseEvent): boolean => {
      if (lookupButtonFromEvent(event.button) === null) return false
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    const onMouseDown = (event: MouseEvent): void => void swallow(event)
    const onAuxClick = (event: MouseEvent): void => void swallow(event)
    const onMouseUp = (event: MouseEvent): void => {
      const button = lookupButtonFromEvent(event.button)
      if (!swallow(event) || button === null) return
      if (buttons) accept(button)
      else setNotice("Mouse buttons can't be the lookup key here")
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) return stop()
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') return stop()
      const modifier = lookupModifierFromKey(event.key, mac)
      if (modifier) return accept(modifier)
      setNotice(buttons ? 'Use Shift, Ctrl, Alt or a mouse button' : 'Use Shift, Ctrl or Alt')
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (lookupButtonFromEvent(event.button) !== null) return
      const target = event.target
      if (!(target instanceof Node) || !buttonRef.current?.contains(target)) stop()
    }
    const onVisibility = (): void => {
      if (document.hidden) stop()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('auxclick', onAuxClick, true)
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mouseup', onMouseUp, true)
      window.removeEventListener('auxclick', onAuxClick, true)
      window.removeEventListener('blur', stop)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [recording, onChange, mac, buttons])

  const label = lookupKeyLabel(value, mac)
  // The current key is always listed, so it shows ticked: Command synced from a Mac reads Super
  // elsewhere, where the recorder and the list do not offer it.
  const offered = lookupKeyChoices(mac, support)
  const choices = offered.includes(value) ? offered : [...offered, value]
  const prompt = buttons ? 'Press a key or mouse button…' : 'Press a key…'
  return (
    <span className="lookup-key-control">
      <ShortcutChip
        kind={isLookupButton(value) ? 'mouse' : 'keys'}
        state={recording ? 'recording' : 'set'}
        buttonRef={buttonRef}
        disabled={disabled}
        label={
          recording
            ? `Recording the lookup key. Press a modifier key${buttons ? ' or a mouse button' : ''}, Escape to cancel.`
            : `Lookup key: ${label}. Click to change.`
        }
        onPress={() => {
          setNotice(null)
          setRecording((on) => !on)
        }}
      >
        {recording ? <span className="shortcut-chip-prompt">{notice ?? prompt}</span> : <Kbd>{label}</Kbd>}
      </ShortcutChip>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label="Choose the lookup key" size="sm" disabled={disabled}>
            <ChevronDown />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              setRecording(false)
              setNotice(null)
              onChange(next as LookupKey)
            }}
          >
            {choices.map((choice) => (
              <MenuRadioItem key={choice} value={choice}>
                {lookupKeyLabel(choice, mac)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </span>
  )
}
