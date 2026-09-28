/**
 * Settings client: a thin, typed layer over `settings_get` / `settings_set` / `settings:changed`,
 * with the shared defaults applied on read.
 *
 * The schema and its defaults live in ONE place for the whole app — `ui/settings.ts`, owned by the
 * overlay workstream — and this module imports them rather than re-declaring them. Transport is
 * deliberately not in that file: the native backend owns the store and each window reaches it
 * through its own client, which is what this is.
 */
import { onSettingsChanged, settingsAll, settingsGet, settingsSet } from './tauri'
import {
  SETTINGS_DEFAULTS,
  DEFAULT_VOICE_ID,
  OCR_MODES,
  withDefaults,
  type Settings,
  type OcrMode
} from '@ui/settings'

export { SETTINGS_DEFAULTS, DEFAULT_VOICE_ID, OCR_MODES, withDefaults }
export type { Settings, OcrMode }

type Listener = (key: string, value: unknown) => void

const listeners = new Set<Listener>()
let subscribed: Promise<void> | null = null

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = onSettingsChanged((key, value) => {
    for (const listener of listeners) listener(key, value)
  }).then(() => undefined)
  subscribed.catch((error) => console.error('[settings] change subscription failed:', error))
}

/**
 * Reads a setting. A stored object is merged over the shared default (via `withDefaults`), so a
 * value written before a field existed does not leave that field undefined.
 */
export async function getSetting<T>(key: string, fallback?: T): Promise<T> {
  const stored = await settingsGet<T>(key)
  if (key in SETTINGS_DEFAULTS) return withDefaults(key as keyof Settings, stored) as T
  if (stored !== null && stored !== undefined) return stored
  return fallback as T
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await settingsSet(key, value)
  // The backend broadcasts to every window including this one, but notifying locally first keeps
  // the writing window responsive if the round trip is slow.
  for (const listener of listeners) listener(key, value)
}

export function onSettingsChange(listener: Listener): () => void {
  ensureSubscribed()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const allSettings = (): Promise<Record<string, unknown>> => settingsAll()
