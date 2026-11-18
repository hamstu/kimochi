/**
 * What the radial menu's previews show (Settings → Shortcuts & Controls → Radial menu, and
 * Settings → Overlay → Radial menu): its items as the overlay labels them, each one's shortcut,
 * and its colour.
 */
import { useMemo } from 'react'
import { RADIAL_ITEMS, radialItemsFor } from '@ui/radial-items.js'
import {
  DEFAULT_OVERLAY_STYLE,
  DEFAULT_RADIAL_BASE,
  radialMenuBaseOf,
  radialMenuColorOf,
  type OverlayStyleSettings,
  type RadialMenuBase
} from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { useHotkeys } from '../../bridge/useHotkeys'
import { useCapabilities } from '../../bridge/capabilities'
import { getButtonName } from '../../bridge/useGamepad'
import { usePadLayout } from '../../bridge/usePadLayout'
import { gamepadChord } from '../../vendor/shared-defaults'
import { formatAccelerator, keyPlatformOf } from './accelerator'

export type RadialItem = (typeof RADIAL_ITEMS)[number]
export type PreviewSource = 'ocr' | 'hooker'

/** The ring's items with `source`, labelled as the overlay labels them. */
export function shownRadialItems(
  menu: string[],
  source: PreviewSource
): { item: RadialItem; label: string; enabled: boolean }[] {
  return radialItemsFor(menu, source === 'hooker').flatMap(({ id, inapplicable }) => {
    const item = RADIAL_ITEMS.find((candidate) => candidate.id === id)
    if (!item) return []
    const label = id === 'ocr-settings' ? (source === 'hooker' ? 'App settings' : 'OCR settings') : item.label
    return [{ item, label, enabled: !inapplicable }]
  })
}

/** Each item's shortcut, for the ring: its controller buttons, or else its keys. */
export function useRadialShortcuts(): Record<string, string | undefined> {
  const [hotkeys] = useHotkeys()
  const keyPlatform = keyPlatformOf(useCapabilities())
  const padLayout = usePadLayout()
  return useMemo(() => {
    const result: Record<string, string | undefined> = {}
    for (const item of RADIAL_ITEMS) {
      const binding = hotkeys[item.hotkey]
      if (!binding) continue
      const chord = gamepadChord(binding)
      result[item.id] =
        chord.length > 0
          ? chord.map((button) => getButtonName(button, padLayout)).join(' + ')
          : binding.accelerator
            ? formatAccelerator(binding.accelerator, keyPlatform)
            : undefined
    }
    return result
  }, [hotkeys, keyPlatform, padLayout])
}

/** The radial menu's colour: its own, or the overlay's highlight colour until one is chosen. */
export function useRadialMenuColor(): string {
  const [stored] = useSetting<string | null>('radialMenuColor', null)
  const [overlayStyle] = useSetting<OverlayStyleSettings>('overlayStyle', DEFAULT_OVERLAY_STYLE)
  return radialMenuColorOf(stored, overlayStyle)
}

/** The radial menu's base colour and opacity (`radialMenuBase`), and saving it. */
export function useRadialMenuBase(): [RadialMenuBase, (next: RadialMenuBase) => void] {
  const [stored, setStored] = useSetting<RadialMenuBase>('radialMenuBase', DEFAULT_RADIAL_BASE)
  return [radialMenuBaseOf(stored), (next) => void setStored(next)]
}
