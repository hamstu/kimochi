/**
 * The Text Hooker source's native side (`src-tauri/src/text_hook`, COMMANDS.md "Text Hooker"):
 * which windows can be hooked, starting and stopping a hook session, the session's live status
 * (`texthook-status`) and the thread the Log reads.
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * The Agent script for a game (text_hook/agent): a script from the Agent collection that knows
 * where the game's text is. Emulated games above all.
 */
export interface AgentScript {
  /** The script's file in the collection (`NS_0100A3A00CC7E000_CLANNAD_JP.js`). */
  file: string
  /** The game, as the script names it. */
  title: string
  /** What runs the game: `switch`, `psp`, `ps2`, `ps3`, `vita`, `3ds`, `pc`, `pc98`. */
  platform: string
  author?: string | null
  version?: string | null
  /** Bytes still to download before it can run (Frida and the scripts); 0 when ready. */
  download: number
  /** Where the scripts come from (their repository). */
  collection: string
}

export interface HookTarget {
  hookable: boolean
  bits?: number
  exe?: string
  /** True when the window belongs to a recognised console emulator (whose title changes when a game boots). */
  emulator?: boolean
  /** Why the window cannot be hooked. */
  reason?: string
  /** The game's Agent script, when the collection has one (and Agent scripts are on). */
  agent?: AgentScript
}

/** The engines a session can be switched between: the game's Agent script, or LunaHook. */
export type HookEngineChoice = 'agent' | 'luna'

export interface HookThread {
  key: string
  /** The hook's name: an engine's, or a Windows API's for the generic hooks. */
  name: string
  hookcode: string
  /** The thread's latest text, its last 160 characters. */
  preview: string
  count: number
  /** Some of its text has read as Japanese (sticky). The menu lists the others only on request. */
  japanese: boolean
  /** One of the generic Windows API hooks rather than an engine hook. */
  generic: boolean
  selected: boolean
}

export type HookPhase = 'idle' | 'starting' | 'downloading' | 'attaching' | 'hooked' | 'ended' | 'failed'

export interface HookStatus {
  supported: boolean
  phase: HookPhase
  detail?: string | null
  /** A page that helps with `detail` (how to update Wine, when the game's is too old). */
  helpUrl?: string | null
  sourceId?: string
  exe?: string | null
  pids?: number[]
  engine?: { id: string; name: string; version: string | null } | null
  /** The engines this session tries, in order (`agent`, `luna`, `textractor`). */
  engines?: string[]
  /** The game's Agent script, when it has one: the card can switch to it or away from it. */
  agent?: AgentScript | null
  download?: { done: number; total: number } | null
  selected?: string | null
  /** `agent`: the Agent script's own text, chosen as soon as it loaded. */
  selectedBy?: 'saved' | 'auto' | 'manual' | 'agent' | null
  /** Why no thread has been chosen automatically yet. */
  pickNote?: string | null
  /** Why the first engine was given up for the one in use. */
  fallback?: string | null
  /** Hook codes the hooker found in the game but could not insert. */
  hookFailures?: string[]
  /** Kimochi reads this Unity game's text itself (the hooker's failures then matter less). */
  unityText?: boolean
  threads: HookThread[]
}

export const IDLE: HookStatus = { supported: false, phase: 'idle', threads: [] }

export const texthookTargets = (sourceIds: string[]): Promise<Record<string, HookTarget>> =>
  invoke<Record<string, HookTarget>>('texthook_targets', { sourceIds })
/** Hooks a window's game; `engine` asks for one first (else the game's choice, else Agent when it has a script). */
export const texthookStart = (
  sourceId: string,
  observerEngine?: string | null,
  engine?: HookEngineChoice | null
): Promise<HookStatus> =>
  invoke<HookStatus>('texthook_start', { sourceId, observerEngine: observerEngine ?? null, engine: engine ?? null })
/** Hooks the game being hooked again, with `engine` first. */
export const texthookEngine = (engine: HookEngineChoice): Promise<HookStatus> =>
  invoke<HookStatus>('texthook_engine', { engine })
export const texthookStop = (): Promise<HookStatus> => invoke<HookStatus>('texthook_stop')
export const texthookStatus = (): Promise<HookStatus> => invoke<HookStatus>('texthook_status')
/** Chooses a thread by hand; `null` goes back to choosing automatically. */
export const texthookSelect = (key: string | null): Promise<HookStatus> =>
  invoke<HookStatus>('texthook_select', { key })

/** The live hook session. */
export function useHookStatus(): HookStatus {
  const [status, setStatus] = useState<HookStatus>(IDLE)
  useEffect(() => {
    let live = true
    void texthookStatus().then(
      (value) => {
        if (live) setStatus(value)
      },
      () => {}
    )
    const pending = listen<HookStatus>('texthook-status', (event) => {
      if (live) setStatus(event.payload)
    })
    return () => {
      live = false
      void pending.then((stop) => stop()).catch(() => {})
    }
  }, [])
  return status
}

/** One sentence of the chosen thread, for the Log. */
export interface HookLine {
  text: string
  key: string
  at: number
}

/** Inserts a hook code (an H-code) into the hooked game now. */
export const texthookInsert = (code: string): Promise<void> => invoke<void>('texthook_insert', { code })
/** The icon kept for a game (taken from its window while it was hooked), as a data URI. */
export const texthookGameIcon = (exe: string): Promise<string | null> =>
  invoke<string | null>('texthook_game_icon', { exe })
/** What is kept natively for a game: the hook code of the thread remembered for it. */
export const texthookGame = (exe: string): Promise<{ thread: string | null }> =>
  invoke<{ thread: string | null }>('texthook_game', { exe })
/** Forgets the thread remembered for a game; with `all`, its icon too. */
export const texthookForget = (exe: string, all: boolean): Promise<void> =>
  invoke<void>('texthook_forget', { exe, all })

/** Opt-in native Mac launch; the game is chosen in a native file dialog. */
export const texthookLaunch = (): Promise<{ launched: boolean; pid?: number; title?: string }> =>
  invoke('texthook_launch')
