/**
 * Click sounds for every control in this window (see `installInteractionSounds` in ui/sounds.ts).
 * The `soundEffects` setting is read at each click, so muting from any window applies at once.
 */
import { useEffect, useRef } from 'react'
import { installInteractionSounds } from '@ui/sounds'
import { useSetting } from '../bridge/useSetting'

export function useInteractionSounds(): void {
  const [soundEffects] = useSetting<boolean>('soundEffects', true)
  const enabled = useRef(soundEffects)
  useEffect(() => {
    enabled.current = soundEffects
  }, [soundEffects])

  useEffect(() => installInteractionSounds(document, { enabled: () => enabled.current }), [])
}
