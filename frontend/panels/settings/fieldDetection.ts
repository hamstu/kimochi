/**
 * A card enhancement's note field, found in Anki (`detectAudioField`, `detectPictureField`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getSettings, onSettingsChange } from '@texthooker/lib/settings'
import { detectAudioField, type FieldDetection } from './sentenceAudioField'

/**
 * The field, found in Anki (`detect`, the Audio field by default): `run` when the switch turns it on, and on
 * its own while it is on, whenever the AnkiConnect address or the Yomitan API's note type changes.
 * `note` says why nothing was found, when Anki answered.
 */
export function useFieldDetection(
  enabled: boolean,
  detect: () => Promise<FieldDetection> = detectAudioField
): { run: () => void; note: string | null } {
  const [note, setNote] = useState<string | null>(null)
  const run = useCallback((): void => {
    void detect().then((found) => setNote(found && !found.ok ? found.reason : null))
  }, [detect])
  const [anki, setAnki] = useState(() => ankiKey(getSettings()))
  useEffect(() => onSettingsChange((next) => setAnki(ankiKey(next))), [])
  const seen = useRef(anki)
  useEffect(() => {
    if (seen.current === anki) return
    seen.current = anki
    if (enabled) run()
  }, [anki, enabled, run])
  return { run, note }
}

/** What a field depends on in the Anki settings. */
function ankiKey(settings: { ankiConnectUrl: string; ankiModelName: string | null }): string {
  return `${settings.ankiConnectUrl}\n${settings.ankiModelName ?? ''}`
}
