import type { ReactNode } from 'react'
import { SettingsRow, Switch } from '@kit'
import { isGamingMode, useCapabilities } from '../../bridge/capabilities'
import { useSetting } from '../../bridge/useSetting'

/**
 * Look up on hover (`overlayHoverLookup`): resting the pointer on a word on the overlay looks it
 * up with no key held. Lookups only: the words keep letting clicks through to the game unless the
 * lookup key is held, so nothing here takes the mouse from it. Native decides when the pointer
 * rests rather than passes by (`state::HoverIntent`); the pop-up closes once the pointer leaves
 * the line, the pop-up and the gap between them (ui/overlay.js `checkPopupLeave`). Not on Wayland, where the pointer is read
 * only while the key is held, nor in Gaming Mode. On Settings → Shortcuts & Controls and Settings → Overlay.
 */
export function HoverLookupRow(): ReactNode {
  const capabilities = useCapabilities()
  const [hover, setHover] = useSetting<boolean>('overlayHoverLookup', false)
  // Gaming Mode has no pointer to rest; the controller reads words there.
  if (isGamingMode(capabilities)) return null
  if (capabilities.os === 'linux' && capabilities.session?.backend === 'wayland') return null
  return (
    <SettingsRow
      label="Look up on hover"
      controlId="overlay-hover-lookup"
      description="Rest the pointer on a word on the overlay to look it up, no key needed. The pop-up closes once the pointer leaves the line and the pop-up."
    >
      <Switch id="overlay-hover-lookup" checked={hover} onCheckedChange={(checked) => void setHover(checked)} />
    </SettingsRow>
  )
}
