/**
 * Hachidori in the language being learned.
 *
 * Which languages: the ones Hachidori's pinned release has a language pack for. Its registry
 * (`vendor/languages/registry.js`, one pack per language) is read when the pin moves, into
 * `extensions/hachidori.languages.json` (scripts/sync-extension.mjs `languageRecord`, checked
 * against the release's hash by `npm run verify` and the tests), so this list is the release's own
 * and is never kept by hand. Native reads the same file (`extensions::reads_language`).
 *
 * How: Hachidori keeps one profile per language (its `options.profiles`, each with its own
 * dictionaries, settings and Anki templates; the id is the language's code), and looks words up in
 * the profile its `languageSelection` names while its experimental "Multiple languages" switch
 * (`options.experimental.multipleLanguages`) is on; with it off, in the Japanese profile. So for
 * the language Kimochi reads (per account), the overlay, which hosts Hachidori, makes sure that
 * language's profile exists (`hd_profile_add`, a copy of the settings in use), the switch is on
 * (`hd_options_write`), and the selection names it (`hd_language_selection_write`): the same
 * requests Hachidori's own Settings → Languages makes. Dictionaries are never installed or
 * removed: a new language starts with none, and Hachidori's settings (which open on the profile
 * lookups use) import them into it.
 *
 * With one account learning Japanese on a Hachidori that has never had another language, nothing
 * is ever written. Kimochi applies the language at Hachidori's start and when the language (or the
 * account) changes; a language chosen in Hachidori's own toolbar meanwhile is left alone.
 */
import record from '../extensions/hachidori.languages.json'
import { LANGUAGE_CODES, languageOf } from './languages.js'

/** Hachidori's code for its Japanese profile (`JAPANESE_PROFILE_ID` in its reader-options.js). */
export const HACHIDORI_JAPANESE = 'ja'

/** The language codes Hachidori's pinned release has packs for (its own codes). */
export const HACHIDORI_PACKS: readonly string[] = record.codes

/**
 * Hachidori's language for a Kimochi code, or null when its release has no pack for it. Chinese is
 * one `zh` there (simplified and traditional both); Cantonese is not Chinese's pack.
 */
export function hachidoriLanguage(code: unknown, packs: readonly string[] = HACHIDORI_PACKS): string | null {
  const language = languageOf(code).code
  const own = language === 'zh-Hans' || language === 'zh-Hant' ? 'zh' : language
  return packs.includes(own) ? own : null
}

/** Kimochi's languages that Hachidori reads, as Kimochi codes. */
export const HACHIDORI_READS: readonly string[] = LANGUAGE_CODES.filter((code) => hachidoriLanguage(code) !== null)

// ---------------------------------------------------------------- deciding (pure)

/** A Hachidori profile as Kimochi needs it. */
export interface HachidoriProfile {
  id: string
  language: string
}

/** Hachidori's stored records this decides from: `options` and `languageSelection`. */
export interface HachidoriLanguageState {
  options?: unknown
  languageSelection?: unknown
}

/** The next request toward the language, or `keep` when lookups already use it. */
export type HachidoriLanguageStep =
  | { kind: 'keep' }
  | { kind: 'add'; language: string; copyFrom: string }
  | { kind: 'enable' }
  | { kind: 'select'; profileId: string }

const plain = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** Its profiles: a record without `profiles` is one Japanese profile (reader-options.js `profiles`). */
export function hachidoriProfiles(options: unknown): HachidoriProfile[] {
  const list = plain(options)?.profiles
  if (!Array.isArray(list)) return [{ id: HACHIDORI_JAPANESE, language: HACHIDORI_JAPANESE }]
  return list.flatMap((value) => {
    const profile = plain(value)
    return typeof profile?.id === 'string' && typeof profile.language === 'string'
      ? [{ id: profile.id, language: profile.language }]
      : []
  })
}

/** Whether "Multiple languages" is on. */
export const multipleLanguagesOn = (options: unknown): boolean =>
  plain(plain(options)?.experimental)?.multipleLanguages === true

/**
 * The profile lookups use (reader-options.js `activeProfileId`): the selection's when the switch is
 * on and it names a profile, else the Japanese profile, else the first.
 */
export function activeHachidoriProfile(state: HachidoriLanguageState): string {
  const list = hachidoriProfiles(state.options)
  const chosen = multipleLanguagesOn(state.options) ? plain(state.languageSelection)?.activeProfileId : null
  if (list.some((profile) => profile.id === chosen)) return chosen as string
  return list.find((profile) => profile.id === HACHIDORI_JAPANESE)?.id ?? list[0]?.id ?? HACHIDORI_JAPANESE
}

/**
 * The next request that brings Hachidori's lookups to `language` (a Kimochi code): its profile
 * first, then the switch, then the selection. `keep` when lookups already use a profile in the
 * language, or Hachidori has no pack for it (the windows then run Yomitan instead).
 */
export function planHachidoriLanguage(
  language: unknown,
  state: HachidoriLanguageState,
  packs: readonly string[] = HACHIDORI_PACKS
): HachidoriLanguageStep {
  const wanted = hachidoriLanguage(language, packs)
  if (wanted === null) return { kind: 'keep' }
  const profiles = hachidoriProfiles(state.options)
  const active = activeHachidoriProfile(state)
  if (profiles.find((profile) => profile.id === active)?.language === wanted) return { kind: 'keep' }
  const target = profiles.find((profile) => profile.language === wanted)
  // A copy of the settings in use, as Hachidori's own "Add language" copies the edited profile's.
  if (!target) return { kind: 'add', language: wanted, copyFrom: active }
  if (!multipleLanguagesOn(state.options)) return { kind: 'enable' }
  return { kind: 'select', profileId: target.id }
}

// ---------------------------------------------------------------- applying it (the overlay)

/** Hachidori, as the overlay's extension host reaches it (host/ext/app.js). */
export interface HachidoriPort {
  /** `chrome.storage.local.get(keys)` in Hachidori's storage. */
  storage: (keys: string[]) => Promise<Record<string, unknown>>
  /** `chrome.runtime.sendMessage(message)` to Hachidori's background; its reply. */
  send: (message: Record<string, unknown>) => Promise<unknown>
  /**
   * Hachidori's own reading of a stored `experimental` (its `HDReaderOptions.normaliseExperimental`,
   * a content script's global): every flag it knows. Its options write refuses an `experimental`
   * that leaves any of them out.
   */
  experimental?: (stored: unknown) => unknown
}

interface Native {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  report: (value: Record<string, unknown>) => unknown
  listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<unknown>
}

/** Hachidori's message targets: its background (`hoshidicts-worker`) and its engine. */
const WORKER = 'hoshidicts-worker'
const ENGINE = 'hoshidicts-offscreen'

/** How many requests one application makes at most (add, enable, select, and one conflict). */
const MAX_STEPS = 6

let requests = 0

/**
 * The request a step makes, against the records it was planned from; `experimental` reads the
 * stored flags as Hachidori does (`HachidoriPort.experimental`).
 */
export function stepMessage(
  step: HachidoriLanguageStep,
  state: HachidoriLanguageState,
  experimental: (stored: unknown) => unknown = (stored) => stored
): Record<string, unknown> | null {
  const requestId = `kimochi-language-${++requests}`
  const options = plain(state.options) ?? {}
  if (step.kind === 'add')
    return { target: ENGINE, type: 'hd_profile_add', requestId, language: step.language, copyFrom: step.copyFrom }
  if (step.kind === 'enable') {
    const revision = Number.isInteger(options.revision) ? (options.revision as number) : 0
    const flags = { ...plain(experimental(options.experimental)), multipleLanguages: true }
    return {
      target: WORKER,
      type: 'hd_options_write',
      requestId,
      baseRevision: revision,
      options: { experimental: flags }
    }
  }
  if (step.kind === 'select') {
    const selection = plain(state.languageSelection)
    const revision = Number.isInteger(selection?.revision) ? (selection?.revision as number) : 0
    return {
      target: WORKER,
      type: 'hd_language_selection_write',
      requestId,
      baseRevision: revision,
      activeProfileId: step.profileId
    }
  }
  return null
}

/**
 * Brings Hachidori's lookups to `language`, one request at a time, reading its records again after
 * each (a conflict, or another page's change, is planned from afresh). Resolves with the profile
 * lookups then use.
 */
export async function applyHachidoriLanguage(
  language: string,
  port: HachidoriPort,
  report: (value: Record<string, unknown>) => unknown = () => undefined
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const state = (await port.storage(['options', 'languageSelection'])) as HachidoriLanguageState
    const step = planHachidoriLanguage(language, state)
    const message = stepMessage(step, state, port.experimental)
    if (!message) return activeHachidoriProfile(state)
    if (attempt >= MAX_STEPS) throw Error(`Hachidori did not settle on ${languageOf(language).name}`)
    const reply = plain(await port.send(message))
    report({ check: 'hachidori-language-step', language, step: step.kind, ok: reply?.ok === true })
    if (reply?.ok !== true && reply?.conflict !== true) {
      throw Error(typeof reply?.error === 'string' && reply.error ? reply.error : `Hachidori refused ${step.kind}`)
    }
  }
}

/**
 * Keep Hachidori's lookups in the language being learned (see the top of this file). Runs once
 * now, then whenever `language` changes or an account switch ends, one run at a time. A run that
 * fails (the engine still loading its dictionaries) is tried again a few times.
 */
export function followHachidoriLanguage({ port, native }: { port: HachidoriPort; native: Native }): void {
  let chain: Promise<void> = Promise.resolve()
  let retry: ReturnType<typeof setTimeout> | null = null

  const follow = async (tries: number): Promise<void> => {
    const status = (await native.invoke('account_status').catch(() => null)) as { switching?: boolean } | null
    // Mid-switch the language is already the new account's: the switch's end runs this again.
    if (status?.switching) return
    const language = languageOf(await native.invoke('settings_get', { key: 'language' }).catch(() => null)).code
    try {
      const profile = await applyHachidoriLanguage(language, port, native.report)
      native.report({ check: 'hachidori-language', language, profile })
    } catch (error) {
      native.report({
        check: 'hachidori-language-failed',
        language,
        error: String((error as Error)?.message ?? error),
        retrying: tries > 0
      })
      if (tries > 0) retry = setTimeout(() => run(tries - 1), 3000)
    }
  }

  const run = (tries = 3): void => {
    if (retry) clearTimeout(retry)
    retry = null
    chain = chain.then(() => follow(tries)).catch(() => undefined)
  }

  run()
  void native.listen('settings:changed', ({ payload }) => {
    if ((payload as { key?: unknown } | null)?.key === 'language') run()
  })
  void native.listen('account-changed', ({ payload }) => {
    if (!(payload as { switching?: boolean } | null)?.switching) run()
  })
}
