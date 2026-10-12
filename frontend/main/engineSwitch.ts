/**
 * Keeps the main window on Settings → Dictionary across the reload a dictionary-engine switch
 * gives it (DICTIONARY_ENGINES.md §2).
 *
 * `dictionary_engine_apply` reloads the `log` window, and Settings is a view inside it, so without
 * this the reload lands on the Log. The main window registers where it is (`registerMainRoute`);
 * Settings → Dictionary calls `rememberEngineSwitch` just before it asks native to reload, which
 * writes an `EngineSwitchRecord` to this window's `sessionStorage`. The reloaded document reads it
 * once (`engineSwitchRecord`), removes it, and every consumer (the main window's first view and
 * page, the scroll offset, the "Now using …" note) renders from the same value on its first frame.
 *
 * Only a window that has registered a route writes a record: the separate Settings window is not
 * reloaded by a switch, so it keeps its own "Reloading the reader windows…" note instead.
 */
import {
  ENGINE_SWITCH_KEY,
  decodeEngineSwitch,
  encodeEngineSwitch,
  type DictionaryEngine,
  type EngineSwitchRecord
} from '@ui/settings'

export type { EngineSwitchRecord }

interface MainRoute {
  tab: string
  back: 'log' | 'notebook'
  scrollTop: number
}

let routeOf: (() => MainRoute) | null = null

/**
 * The main window says where it is, for a switch made from its Settings view. Returns the
 * unregister function (an effect cleanup).
 */
export function registerMainRoute(read: () => MainRoute): () => void {
  routeOf = read
  return () => {
    if (routeOf === read) routeOf = null
  }
}

/**
 * Records the switch before native reloads this window. True when a record was written (this is
 * the main window, which the switch reloads); false elsewhere.
 */
export function rememberEngineSwitch(engine: DictionaryEngine): boolean {
  if (!routeOf) return false
  const route = routeOf()
  const record: EngineSwitchRecord = { engine, view: 'settings', ...route, at: Date.now() }
  try {
    sessionStorage.setItem(ENGINE_SWITCH_KEY, encodeEngineSwitch(record))
    return true
  } catch {
    // No sessionStorage: the reload lands on the Log, as it did before.
    return false
  }
}

/** The switch did not reload this window after all (the command failed): forget the record. */
export function forgetEngineSwitch(): void {
  try {
    sessionStorage.removeItem(ENGINE_SWITCH_KEY)
  } catch {
    // Nothing to forget.
  }
}

let taken = false
let record: EngineSwitchRecord | null = null

/**
 * The record this document was reloaded with, or null. Read and removed from storage on the first
 * call; later calls (StrictMode's second mount, other consumers) get the same value.
 */
export function engineSwitchRecord(): EngineSwitchRecord | null {
  if (taken) return record
  taken = true
  try {
    record = decodeEngineSwitch(sessionStorage.getItem(ENGINE_SWITCH_KEY), Date.now())
    sessionStorage.removeItem(ENGINE_SWITCH_KEY)
  } catch {
    record = null
  }
  return record
}
