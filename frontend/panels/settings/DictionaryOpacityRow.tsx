/**
 * Dictionary opacity (`dictionaryPopupOpacity`): every engine's dictionary pop-up is drawn at it,
 * so the game shows through (host/popup-bridge.js for Yomitan, host/ext/content.js for Hachidori
 * and 10ten, PopoverApp for the Yomitan API). 10 to 100, never off: a pop-up nobody can see would
 * still take the mouse. On Settings → Dictionary and under Settings → Overlay → Overlay
 * appearance, with Highlight opacity's slider and scale (`OpacityScale`).
 */
import type { ReactNode } from 'react'
import { SettingsRow, Slider } from '@kit'
import { popupOpacityOf } from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { OpacityScale } from './OverlayLook'
import './overlay-look.css'

export const MIN_POPUP_OPACITY = 10

export function DictionaryOpacityRow(): ReactNode {
  const [stored, setStored] = useSetting<number>('dictionaryPopupOpacity', 100)
  // Saved as the thumb moves (in steps of 5), so the pop-ups and the preview follow it live.
  const value = popupOpacityOf(stored)
  const choose = (next: number): void => {
    if (next !== value) void setStored(next)
  }
  return (
    <SettingsRow
      label="Dictionary opacity"
      controlId="dictionary-popup-opacity"
      description="Lower it to see your game through the dictionary pop-up, with every dictionary."
    >
      <div className="overlay-look-opacity-control dictionary-opacity-control">
        <Slider
          id="dictionary-popup-opacity"
          aria-label="Dictionary opacity"
          valueText={(percent) => `${percent}%`}
          value={[value]}
          onValueChange={(values) => choose(values[0])}
          min={MIN_POPUP_OPACITY}
          max={100}
          step={5}
        />
        <OpacityScale value={value} min={MIN_POPUP_OPACITY} onChoose={choose} />
      </div>
    </SettingsRow>
  )
}
