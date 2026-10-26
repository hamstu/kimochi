/**
 * Click sounds for every control in this window (see `installInteractionSounds` in ui/sounds.ts).
 * The sound settings are read at each click, so muting from any window applies at once.
 */
import { useEffect, useRef } from 'react'
import { installInteractionSounds, soundKind, soundKindOn, type SoundSettings } from '@ui/sounds'
import { useSetting } from '../bridge/useSetting'

export function useInteractionSounds(): void {
  const [soundEffects] = useSetting<boolean>('soundEffects', true)
  const [soundEffectsScans] = useSetting<boolean>('soundEffectsScans', true)
  const [soundEffectsClicks] = useSetting<boolean>('soundEffectsClicks', true)
  const settings = useRef<SoundSettings>({})
  useEffect(() => {
    settings.current = { soundEffects, soundEffectsScans, soundEffectsClicks }
  }, [soundEffects, soundEffectsScans, soundEffectsClicks])

  useEffect(
    () =>
      installInteractionSounds(document, {
        enabled: (name) => soundKindOn(settings.current, soundKind(name))
      }),
    []
  )
}
