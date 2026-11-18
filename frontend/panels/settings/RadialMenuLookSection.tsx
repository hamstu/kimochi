/**
 * Settings → Overlay → Radial menu: how the radial menu looks over a game. A picture of the menu
 * as it opens with an OCR source (`RadialPreview`, not editable here) and its look
 * (`useRadialStyle`: base colour, accent colour, base opacity), as in Settings → Shortcuts &
 * Controls → Radial menu, where what it holds and its shortcuts are edited too.
 */
import { useMemo, type ReactNode } from 'react'
import { SettingsSection } from '@kit'
import { effectiveRadialMenu, RADIAL_MENU_SETTING } from '@ui/radial-items.js'
import { useSetting } from '../../bridge/useSetting'
import { RadialPreview } from './RadialMenuSection'
import { RADIAL_STYLE_DESCRIPTION, shownRadialItems, useRadialShortcuts } from './radialMenuPreview'
import { useRadialStyle } from './RadialStyle'

export function RadialMenuLookSection(): ReactNode {
  const [stored] = useSetting<string[] | null>(RADIAL_MENU_SETTING, null)
  const items = useMemo(() => shownRadialItems(effectiveRadialMenu(stored), 'ocr'), [stored])
  const details = useRadialShortcuts()
  const { accent, base, controls } = useRadialStyle()
  return (
    <SettingsSection title="Radial menu" description={RADIAL_STYLE_DESCRIPTION}>
      <RadialPreview items={items} selected={null} details={details} color={accent} base={base} interactive={false} />
      {controls}
    </SettingsSection>
  )
}
