/**
 * Built-in Yomitan's profiles and which one each account uses (ui/yomitan-profiles.ts), as the
 * panels see them: the overlay, which hosts Yomitan, publishes the profiles (`yomitan_profiles`,
 * the `yomitan-profiles` event); the link is the machine key `yomitanProfiles`, which the overlay
 * follows as soon as it changes.
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  YOMITAN_PROFILES_KEY,
  accountSlot,
  normalizeLinks,
  yomitanLanguage,
  type ProfileLink,
  type ProfileLinks
} from '@ui/yomitan-profiles'
import { languageOf, LANGUAGES } from '@ui/languages'
import { onEvent } from './tauri'
import { useSetting } from './useSetting'
import { setSetting } from './settings'

export interface YomitanProfiles {
  /** The account they were published for (`local` or an account key). */
  account: string
  profiles: { name: string; language: string }[]
  /** `profileCurrent`. */
  current: number
  link: ProfileLink | null
}

function normalize(value: unknown): YomitanProfiles | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.profiles)) return null
  return {
    account: typeof raw.account === 'string' ? raw.account : 'local',
    profiles: raw.profiles
      .filter((p): p is { name: string; language?: unknown } => typeof (p as { name?: unknown })?.name === 'string')
      .map((p) => ({ name: p.name, language: typeof p.language === 'string' ? p.language : 'ja' })),
    current: typeof raw.current === 'number' ? raw.current : 0,
    link: (raw.link as ProfileLink | null) ?? null
  }
}

/** The profiles as last published, live; null until Yomitan has run this session. */
export function useYomitanProfiles(): YomitanProfiles | null {
  const [profiles, setProfiles] = useState<YomitanProfiles | null>(null)
  useEffect(() => {
    let closed = false
    let stop: (() => void) | null = null
    onEvent<unknown>('yomitan-profiles', (payload) => setProfiles(normalize(payload)))
      .then((unlisten) => (closed ? unlisten() : (stop = unlisten)))
      .catch(() => undefined)
    invoke('yomitan_profiles').then(
      (value) => !closed && setProfiles((shown) => shown ?? normalize(value)),
      () => undefined
    )
    return () => {
      closed = true
      stop?.()
    }
  }, [])
  return profiles
}

/** Every account's link, live. */
export function useProfileLinks(): ProfileLinks {
  const [links] = useSetting<unknown>(YOMITAN_PROFILES_KEY, {})
  return normalizeLinks(links)
}

/** Ties `account` (an account key, or null for Local) to the profile `name`, for `language`. */
export async function chooseYomitanProfile(
  links: ProfileLinks,
  account: string | null | undefined,
  name: string,
  language: string
): Promise<void> {
  const next: ProfileLinks = { ...links, [accountSlot(account)]: { profile: name, language, chosen: true } }
  await setSetting(YOMITAN_PROFILES_KEY, next)
}

/** A profile's Yomitan language by name ("English"), from Kimochi's table where it has one. */
export function profileLanguageName(code: string): string {
  if (code === 'zh') return 'Chinese'
  const known = LANGUAGES.find((language) => yomitanLanguage(language.code) === code)
  return known ? known.name : code
}

/** Whether a profile's language is the one being learned. */
export const profileReads = (profileLanguage: string, learning: string): boolean =>
  profileLanguage === yomitanLanguage(languageOf(learning).code)
