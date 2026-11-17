/**
 * One shortcut, keyboard or controller, as Settings shows it: a single control with what it is on
 * the left (a keyboard or gamepad icon in a darker cap, divided off), the keys or buttons in the
 * middle, and, once one is set, a faint × at the right end that clears it. Click the middle to
 * record a new one. ShortcutRecorder (keys) and GamepadButtonCapture (buttons) draw through it, so
 * the two sit side by side looking the same.
 *
 * The × is its own button beside the main one, inside the same frame, not nested in it: both stay
 * reachable by Tab and each has its own label.
 */
import { type ReactNode, type Ref } from 'react'
import { Gamepad2, Keyboard, X } from 'lucide-react'

export interface ShortcutChipProps {
  kind: 'keys' | 'pad'
  /** `empty` reads "Set"; `recording` is outlined in the accent while it waits for input. */
  state: 'empty' | 'set' | 'recording'
  /** What it shows: key caps, button names, or a prompt while recording. */
  children: ReactNode
  /** The main button's accessible name. */
  label: string
  onPress: () => void
  /** Clearing, when something is set; leave it out for no ×. */
  onClear?: () => void
  clearLabel?: string
  /** Only the main button: a set shortcut stays clearable while it can't be changed. */
  disabled?: boolean
  title?: string
  buttonRef?: Ref<HTMLButtonElement>
}

export function ShortcutChip({
  kind,
  state,
  children,
  label,
  onPress,
  onClear,
  clearLabel,
  disabled = false,
  title,
  buttonRef
}: ShortcutChipProps): ReactNode {
  const Icon = kind === 'pad' ? Gamepad2 : Keyboard
  return (
    <span
      className="shortcut-chip"
      data-kind={kind}
      data-state={state}
      data-clearable={onClear ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
    >
      <button
        ref={buttonRef}
        type="button"
        className="shortcut-chip-main"
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={onPress}
      >
        <span className="shortcut-chip-kind" aria-hidden>
          <Icon />
        </span>
        <span className="shortcut-chip-value">{children}</span>
      </button>
      {onClear && (
        <button
          type="button"
          className="shortcut-chip-clear"
          aria-label={clearLabel ?? 'Clear shortcut'}
          title={clearLabel ?? 'Clear shortcut'}
          onClick={(event) => {
            event.stopPropagation()
            onClear()
          }}
        >
          <X />
        </button>
      )}
    </span>
  )
}
