/**
 * Dictionary opacity (`dictionaryPopupOpacity`): every engine's dictionary pop-up is drawn at it,
 * so the game shows through (host/popup-bridge.js for Yomitan, host/ext/content.js for Hachidori
 * and 10ten, PopoverApp for the Yomitan API). 10 to 100, never off: a pop-up nobody can see would
 * still take the mouse. On Settings → Dictionary and under Settings → Overlay → Overlay
 * appearance, with Highlight opacity's slider and scale (`OpacityScale`).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { SettingsRow, Slider } from '@kit'
import { popupOpacityOf } from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { OpacityScale } from './OverlayLook'
import './overlay-look.css'

export const MIN_POPUP_OPACITY = 10

export function DictionaryOpacityRow(): ReactNode {
  const [stored, setStored] = useSetting<number>('dictionaryPopupOpacity', 100)
  const saved = popupOpacityOf(stored)
  // The slider follows the thumb at once, the setting a moment after it rests (as Highlight opacity).
  const [draft, setDraft] = useState<number | null>(null)
  const value = draft ?? saved
  useEffect(() => {
    if (draft === null) return
    const timer = setTimeout(() => {
      setDraft(null)
      if (draft !== saved) void setStored(draft)
    }, 250)
    return () => clearTimeout(timer)
  }, [draft, saved, setStored])
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
          onValueChange={(values) => setDraft(values[0])}
          min={MIN_POPUP_OPACITY}
          max={100}
          step={5}
        />
        <OpacityScale value={value} min={MIN_POPUP_OPACITY} onChoose={setDraft} />
      </div>
    </SettingsRow>
  )
}
