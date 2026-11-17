/**
 * The card looks, as one dropdown for both places that choose one: the overlay's cards (Settings →
 * Overlay → Overlay appearance, `overlayStyle.appearance`) and the Text Hooker's card (Settings →
 * Text Hooker → Card style and Settings → Overlay → Text Hooker card, `overlayStyle.hookAppearance`).
 * The two are separate settings with the same choices. Transparent draws nothing, so it has a line
 * saying what is left (`TransparentNote`), and the previews a mark saying why they look empty
 * (`TransparentMark`).
 */
import type { ReactNode } from 'react'
import { Blend, EyeOff, Monitor, Moon, Sun } from 'lucide-react'
import { Select, SettingsRow } from '@kit'
import {
  DEFAULT_OVERLAY_STYLE,
  overlayStyleOf,
  type OverlayCardAppearance,
  type OverlayStyleSettings
} from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'

const CARD_CHOICES: readonly {
  value: OverlayCardAppearance
  label: string
  icon: ReactNode
}[] = [
  { value: 'app', label: 'Same as Kimochi', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
  { value: 'blend', label: 'Blend', icon: <Blend /> },
  { value: 'transparent', label: 'Transparent', icon: <EyeOff /> }
]

export function CardLookSelect({
  value,
  onChange,
  label,
  className
}: {
  value: OverlayCardAppearance
  onChange: (value: OverlayCardAppearance) => void
  /** Its accessible name. */
  label: string
  className?: string
}): ReactNode {
  return (
    <Select
      aria-label={label}
      className={className ?? 'overlay-look-card-select'}
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(next)
      }}
      options={CARD_CHOICES.map((choice) => ({
        value: choice.value,
        label: (
          <span className="overlay-look-card-option">
            {choice.icon}
            {choice.label}
          </span>
        )
      }))}
    />
  )
}

/** What Transparent leaves: the line under a look chosen as Transparent. */
export function TransparentNote({ what }: { what: string }): ReactNode {
  return <span className="overlay-look-note">{what} Only the dictionary pop-up shows when you look a word up.</span>
}

/** Over a preview drawn Transparent, which shows nothing of the overlay: why. */
export function TransparentMark({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="overlay-look-transparent-mark" aria-hidden>
      <EyeOff />
      {children}
    </span>
  )
}

/**
 * The Text Hooker's card's look (`overlayStyle.hookAppearance`) and its setter, which keeps the
 * rest of the overlay's style as it is.
 */
function useHookCardLook(): [OverlayCardAppearance, (value: OverlayCardAppearance) => void] {
  const [stored, setStored] = useSetting<OverlayStyleSettings>('overlayStyle', DEFAULT_OVERLAY_STYLE)
  const style = overlayStyleOf(stored)
  return [style.hookAppearance, (hookAppearance) => void setStored({ ...style, hookAppearance })]
}

/**
 * Settings' row for the card's look, with what each choice does: Text Hooker → Card style, and
 * Overlay → Text Hooker card.
 */
export function HookCardLookRow({ shared }: { shared?: boolean }): ReactNode {
  const [look, setLook] = useHookCardLook()
  return (
    <SettingsRow
      label="Card look"
      description={
        look === 'transparent'
          ? 'Nothing of the card shows over the game, even with the lookup key held. Pointing at its text still opens the dictionary pop-up.'
          : `Separate from the overlay's cards.${shared ? ' The same for every game.' : ''}`
      }
    >
      <CardLookSelect label="Card look" className="hook-card-look-select" value={look} onChange={setLook} />
    </SettingsRow>
  )
}
