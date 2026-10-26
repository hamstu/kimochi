/**
 * Click sounds for every control in this window (see `installInteractionSounds` in ui/sounds.ts).
 * The sound settings are read at each click, so muting from any window applies at once; none
 * plays while sentence audio records.
 */
import { useEffect, useRef } from 'react'
import { installInteractionSounds, recordingAudio, setSoundVolume, soundKind, soundKindOn, type SoundSettings } from '@ui/sounds'
import { useSetting } from '../bridge/useSetting'

export function useInteractionSounds(): void {
  const [soundEffects] = useSetting<boolean>('soundEffects', true)
  const [soundEffectsScans] = useSetting<boolean>('soundEffectsScans', true)
  const [soundEffectsClicks] = useSetting<boolean>('soundEffectsClicks', true)
  const [soundEffectsVolume] = useSetting<number>('soundEffectsVolume', 0.5)
  const [sentenceAudio] = useSetting<unknown>('sentenceAudio', null)
  // Every sound in this window plays at it, the clicks below and any other (playAudio).
  useEffect(() => setSoundVolume(soundEffectsVolume), [soundEffectsVolume])
  const settings = useRef<SoundSettings>({})
  useEffect(() => {
    settings.current = { soundEffects, soundEffectsScans, soundEffectsClicks, sentenceAudio }
  }, [soundEffects, soundEffectsScans, soundEffectsClicks, sentenceAudio])

  useEffect(
    () =>
      installInteractionSounds(document, {
        enabled: (name) => soundKindOn(settings.current, soundKind(name)),
        silenced: () => recordingAudio(settings.current.sentenceAudio)
      }),
    []
  )
}
