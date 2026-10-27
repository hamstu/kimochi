/**
 * Finds sentence audio's Audio field in Anki: when the feature is turned on (the sidebar's
 * Enhance Anki cards or Settings → Anki → Card enhancement) and when the Anki settings it depends
 * on change (the AnkiConnect address, the Yomitan API's note type). Saves the field when found;
 * says why not when Anki answered but no field fits, and nothing when Anki can't be reached.
 */
import { SETTINGS_DEFAULTS, type CardScreenshotSettings, type SentenceAudioSettings } from '@ui/settings'
import { DEFAULT_ANKI_CONNECT_URL } from '@ui/anki-connect'
import { detectPictureField as findPictureField, detectSentenceAudioField } from '@texthooker/lib/ankiDetect'
import { findNotesByQuery, listModelFields, listModels } from '@texthooker/lib/ankiconnect'
import { getSettings } from '@texthooker/lib/settings'
import { getSetting, setSetting } from '../../bridge/settings'

export type FieldDetection = { ok: true; field: string; modelName: string } | { ok: false; reason: string } | null

export async function detectAudioField(): Promise<FieldDetection> {
  const reader = getSettings()
  const url = reader.ankiConnectUrl || DEFAULT_ANKI_CONNECT_URL
  let found
  try {
    found = await detectSentenceAudioField(
      {
        models: () => listModels(url),
        fields: (model) => listModelFields(url, model),
        findNotes: (query) => findNotesByQuery(url, query)
      },
      reader.ankiModelName
    )
  } catch {
    return null
  }
  if (!found.ok) return found
  const stored = await getSetting<Partial<SentenceAudioSettings>>('sentenceAudio', {})
  const config = { ...SETTINGS_DEFAULTS.sentenceAudio, ...stored }
  if (config.field !== found.field) await setSetting('sentenceAudio', { ...config, field: found.field })
  return found
}

/** The screenshot's Picture field, found and saved the same way: when the screenshot is turned on
    and when the Anki settings change. */
export async function detectPictureField(): Promise<FieldDetection> {
  const reader = getSettings()
  const url = reader.ankiConnectUrl || DEFAULT_ANKI_CONNECT_URL
  let found
  try {
    found = await findPictureField(
      {
        models: () => listModels(url),
        fields: (model) => listModelFields(url, model),
        findNotes: (query) => findNotesByQuery(url, query)
      },
      reader.ankiModelName
    )
  } catch {
    return null
  }
  if (!found.ok) return found
  const stored = await getSetting<Partial<CardScreenshotSettings>>('cardScreenshot', {})
  const config = { ...SETTINGS_DEFAULTS.cardScreenshot, ...stored }
  if (config.field !== found.field) await setSetting('cardScreenshot', { ...config, field: found.field })
  return found
}
