/**
 * Built-in Yomitan's profiles, tied to Kimochi's accounts.
 *
 * Dictionaries stay shared by every account on this computer (one Yomitan, one IndexedDB), but a
 * Yomitan profile carries its own language (`general.language`), its own enabled dictionaries and
 * its own scanning options. So each account looks words up through a profile:
 *
 * - The first account uses Yomitan's default profile, whatever its language.
 * - An account set to another language gets a profile for it: one already in that language, or a
 *   new one named after the language (a copy of the default profile's options with
 *   `general.language` and Yomitan's recommended settings for the language; dictionaries are left
 *   exactly as they are, never installed, removed or switched).
 * - Switching account switches Yomitan's current profile (`profileCurrent`).
 * - Settings → Account can tie the account to any profile instead (a link with `chosen`).
 *
 * The links are the machine key `yomitanProfiles`: `{<account>: {profile, language, chosen?}}`,
 * where `<account>` is the account key or `local`, `profile` the profile's name (Yomitan gives
 * profiles no id; the name survives reordering, and a renamed or deleted profile is found again
 * by language or falls back to the default profile, and the link is repaired), and `language` the
 * Kimochi language the link was made for (a language change looks again). Profiles themselves
 * are made, renamed and deleted in Yomitan's own settings.
 *
 * `planYomitanProfile` decides (pure, `scripts/yomitan-profiles.test.mjs`); `followYomitanProfiles`
 * runs it in the overlay, which hosts Yomitan's backend, at Yomitan's start, on a change of
 * `language` or `yomitanProfiles`, and after an account switch, and publishes the profiles for
 * Settings (`report` `check: 'yomitan-profiles'`, read back with `yomitan_profiles`).
 *
 * With one account learning Japanese and Yomitan on its default profile, nothing is ever written.
 */
import { isJapanese, languageOf } from './languages.js'

/** The machine key holding the links. */
export const YOMITAN_PROFILES_KEY = 'yomitanProfiles'
/** The account slot of the Local profile (no account). */
export const LOCAL_ACCOUNT = 'local'

export interface ProfileLink {
  /** The Yomitan profile's name. */
  profile: string
  /** The Kimochi language code the link was made for. */
  language: string
  /** Chosen in Settings → Account, rather than found or made by Kimochi. */
  chosen?: boolean
}
export type ProfileLinks = Record<string, ProfileLink>

/** A Yomitan profile as Kimochi needs it. */
export interface ProfileInfo {
  name: string
  /** Its `general.language` (a Yomitan code). */
  language: string
  /** How many dictionaries it has enabled. */
  dictionaries: number
}

export interface ProfileState {
  profiles: ProfileInfo[]
  /** `profileCurrent`. */
  current: number
}

/** What to do with Yomitan's profiles. `link` is what to record for the account (null: nothing). */
export type ProfilePlan =
  | { kind: 'keep' }
  | { kind: 'use'; index: number; link: ProfileLink | null }
  | { kind: 'adopt'; index: number; language: string; link: ProfileLink }
  | { kind: 'create'; name: string; language: string; link: ProfileLink }

/** The slot an account's link is kept under: its key, or `local`. */
export const accountSlot = (key: string | null | undefined): string => (key ? key : LOCAL_ACCOUNT)

/**
 * Yomitan's `general.language` for a Kimochi code: Chinese is one `zh` there; every other code
 * Kimochi lists is Yomitan's own (`docs/languages-audit/language-data.md` §1).
 */
export function yomitanLanguage(code: unknown): string {
  const language = languageOf(code).code
  return language === 'zh-Hans' || language === 'zh-Hant' ? 'zh' : language
}

/** The stored links, keeping only well-formed ones. */
export function normalizeLinks(value: unknown): ProfileLinks {
  const links: ProfileLinks = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return links
  for (const [slot, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const { profile, language, chosen } = raw as Record<string, unknown>
    if (typeof profile !== 'string' || !profile || typeof language !== 'string') continue
    links[slot] = chosen === true ? { profile, language, chosen: true } : { profile, language }
  }
  return links
}

/** Yomitan's options document as `ProfileState`. */
export function profileState(options: unknown): ProfileState {
  const raw = (options ?? {}) as { profiles?: unknown; profileCurrent?: unknown }
  const profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).map((profile: unknown, index: number) => {
    const p = (profile ?? {}) as { name?: unknown; options?: { general?: { language?: unknown }; dictionaries?: unknown } }
    const dictionaries = Array.isArray(p.options?.dictionaries) ? p.options.dictionaries : []
    return {
      name: typeof p.name === 'string' ? p.name : `Profile ${index + 1}`,
      language: typeof p.options?.general?.language === 'string' ? p.options.general.language : 'ja',
      dictionaries: dictionaries.filter((d: unknown) => (d as { enabled?: unknown } | null)?.enabled === true).length
    }
  })
  const current = typeof raw.profileCurrent === 'number' && raw.profileCurrent >= 0 && raw.profileCurrent < profiles.length
    ? raw.profileCurrent
    : 0
  return { profiles, current }
}

/** A name no profile has: the language's ("Korean"), then "Korean (2)", … */
export function uniqueProfileName(base: string, profiles: readonly ProfileInfo[]): string {
  const taken = new Set(profiles.map((profile) => profile.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`
}

/**
 * Which profile `account` looks words up through, learning `language`:
 *
 * 1. Its link, made for this language, to a profile that still exists.
 * 2. Never linked, Japanese, at Yomitan's start: Yomitan is left as it is (a Japanese reader with
 *    one account never sees a change, whatever profile they keep current).
 * 3. The current profile, when it is in the language.
 * 4. Another profile in the language.
 * 5. A link whose profile was renamed or deleted: the default profile (the first).
 * 6. The default profile, when no other account uses it and it has no dictionaries enabled (a
 *    first run): it takes the language. So the first account uses the default profile.
 * 7. A new profile for the language.
 *
 * The link is recorded whenever the answer is not simply "the current profile, never linked".
 */
export function planYomitanProfile({
  account,
  language,
  links,
  state,
  trigger
}: {
  account: string
  language: string
  links: ProfileLinks
  state: ProfileState
  /** `startup`: Yomitan just started; `change`: the language, an account or a link changed. */
  trigger: 'startup' | 'change'
}): ProfilePlan {
  const { profiles, current } = state
  if (profiles.length === 0) return { kind: 'keep' }
  const code = languageOf(language).code
  const wanted = yomitanLanguage(code)
  const link = links[account]
  const linkFor = (index: number): ProfileLink => ({ profile: profiles[index].name, language: code })
  const use = (index: number, record: boolean): ProfilePlan =>
    !record && index === current ? { kind: 'keep' } : { kind: 'use', index, link: record ? linkFor(index) : null }

  const linked = link && link.language === code ? profiles.findIndex((p) => p.name === link.profile) : -1
  if (linked >= 0) return use(linked, false)
  const lost = !!link && link.language === code

  if (!link && trigger === 'startup' && isJapanese(code)) return { kind: 'keep' }

  if (profiles[current]?.language === wanted) return use(current, !!link)
  const same = profiles.findIndex((p) => p.language === wanted)
  if (same >= 0) return use(same, true)

  if (lost) return use(0, true)

  const claimed = Object.entries(links).some(([slot, other]) => slot !== account && other.profile === profiles[0].name)
  if (!claimed && profiles[0].dictionaries === 0) {
    return { kind: 'adopt', index: 0, language: wanted, link: linkFor(0) }
  }

  const name = uniqueProfileName(languageOf(code).name, profiles)
  return { kind: 'create', name, language: wanted, link: { profile: name, language: code } }
}

// ---------------------------------------------------------------- applying it (the overlay)

/** One of Yomitan's recommended settings (`data/recommended-settings.json`). */
interface Recommended {
  modification?: { action?: string; path?: string; value?: unknown }
}

/** The `set` modifications Yomitan recommends for `language` (a Yomitan code). */
export function recommendedSets(table: unknown, language: string): { path: string; value: unknown }[] {
  const entries = (table as Record<string, unknown> | null)?.[language]
  if (!Array.isArray(entries)) return []
  return (entries as Recommended[])
    .map((entry) => entry?.modification)
    .filter((m): m is { action: string; path: string; value: unknown } =>
      m?.action === 'set' && typeof m.path === 'string' && /^[\w.]+$/.test(m.path))
    .map(({ path, value }) => ({ path, value }))
}

/** Sets a dotted path in a plain object, making the objects on the way. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let node = target
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[keys[keys.length - 1]] = value
}

type Api = (action: string, params?: unknown) => Promise<unknown>

interface Native {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  report: (value: Record<string, unknown>) => unknown
  listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<unknown>
}

interface Modification {
  scope: 'global'
  action: 'set' | 'splice'
  path: string
  value?: unknown
  start?: number
  deleteCount?: number
  items?: unknown[]
}

/** The modifications that carry out a plan (on `options`, Yomitan's whole options document). */
export function planModifications(
  plan: ProfilePlan,
  options: { profiles: { options: Record<string, unknown> }[] },
  recommended: unknown
): Modification[] {
  if (plan.kind === 'keep') return []
  const current = (index: number): Modification => ({ scope: 'global', action: 'set', path: 'profileCurrent', value: index })
  if (plan.kind === 'use') return [current(plan.index)]
  const sets = [{ path: 'general.language', value: plan.language }, ...recommendedSets(recommended, plan.language)]
  if (plan.kind === 'adopt') {
    return [
      ...sets.map(({ path, value }): Modification => ({
        scope: 'global',
        action: 'set',
        path: `profiles[${plan.index}].options.${path}`,
        value
      })),
      current(plan.index)
    ]
  }
  // A copy of the default profile's options, dictionaries and all, in the new language.
  const copy = structuredClone(options.profiles[0].options)
  for (const { path, value } of sets) setPath(copy, path, structuredClone(value))
  const index = options.profiles.length
  return [
    { scope: 'global', action: 'splice', path: 'profiles', start: index, deleteCount: 0,
      items: [{ name: plan.name, conditionGroups: [], options: copy }] },
    current(index)
  ]
}

/**
 * Keep Yomitan's current profile on the active account's (see the top of this file). `api` is
 * the backend's message API (`optionsGetFull`, `modifySettings`); `native` the overlay's bridge.
 * Runs once now, then on every trigger, one run at a time.
 */
export function followYomitanProfiles({
  api,
  native,
  onOptionsUpdated
}: {
  api: Api
  native: Native
  /** Calls back whenever Yomitan's options change (its `applicationOptionsUpdated`). */
  onOptionsUpdated: (callback: () => void) => void
}): void {
  let chain: Promise<void> = Promise.resolve()
  let account: string | null = null
  let recommended: unknown = null

  const setting = async (key: string): Promise<unknown> => native.invoke('settings_get', { key }).catch(() => null)

  const publish = async (slot: string, links: ProfileLinks): Promise<void> => {
    const { profiles, current } = profileState(await api('optionsGetFull'))
    native.report({
      check: 'yomitan-profiles',
      account: slot,
      profiles: profiles.map(({ name, language }) => ({ name, language })),
      current,
      link: links[slot] ?? null
    })
  }

  const follow = async (trigger: 'startup' | 'change'): Promise<void> => {
    const status = (await native.invoke('account_status').catch(() => null)) as
      | { switching?: boolean; profile?: { key?: string | null } }
      | null
    // Mid-switch the language already is the new account's while the account is not yet: the
    // switch's own `account-changed` runs this again once it is done.
    if (status?.switching) return
    const slot = accountSlot(status?.profile?.key)
    account = slot
    const language = languageOf(await setting('language')).code
    const links = normalizeLinks(await setting(YOMITAN_PROFILES_KEY))
    const options = (await api('optionsGetFull')) as { profiles: { options: Record<string, unknown> }[] }
    const plan = planYomitanProfile({ account: slot, language, links, state: profileState(options), trigger })
    if (plan.kind !== 'keep') {
      if (plan.kind !== 'use' && recommended === null) {
        // Served with Yomitan at the app origin.
        recommended = await fetch('/data/recommended-settings.json').then((r) => (r.ok ? r.json() : {}), () => ({}))
      }
      const targets = planModifications(plan, options, recommended)
      const results = (await api('modifySettings', { targets, source: 'kimochi-profiles' })) as { error?: unknown }[] | null
      const failed = results?.find((result) => result?.error)
      if (failed) throw Error(`Yomitan refused the profile change: ${JSON.stringify(failed.error)}`)
      native.report({ check: 'yomitan-profile', account: slot, language, plan: plan.kind, profile: plan.kind === 'use' ? null : plan.link.profile, index: 'index' in plan ? plan.index : null })
      if (plan.link) {
        const next = { ...links, [slot]: plan.link }
        await native.invoke('settings_set', { key: YOMITAN_PROFILES_KEY, value: next })
        await publish(slot, next)
        return
      }
    }
    await publish(slot, links)
  }

  const run = (trigger: 'startup' | 'change'): void => {
    chain = chain
      .then(() => follow(trigger))
      .catch((error: unknown) =>
        void native.report({ check: 'yomitan-profile-failed', error: String((error as Error)?.message ?? error) }))
  }

  run('startup')
  void native.listen('settings:changed', ({ payload }) => {
    const key = (payload as { key?: unknown } | null)?.key
    if (key === 'language' || key === YOMITAN_PROFILES_KEY) run('change')
  })
  void native.listen('account-changed', ({ payload }) => {
    const status = payload as { switching?: boolean; profile?: { key?: string | null } } | null
    if (!status || status.switching) return
    if (accountSlot(status.profile?.key) !== account) run('change')
  })
  // A profile added, renamed or removed in Yomitan's settings: Settings → Account sees it.
  onOptionsUpdated(() => {
    chain = chain
      .then(async () => {
        if (account) await publish(account, normalizeLinks(await setting(YOMITAN_PROFILES_KEY)))
      })
      .catch(() => undefined)
  })
}
