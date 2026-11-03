/**
 * The Text Hooker source's native side (`src-tauri/src/text_hook`, COMMANDS.md "Text Hooker"):
 * which windows can be hooked, starting and stopping a hook session, the session's live status
 * (`texthook-status`) and the thread the Log reads.
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface HookTarget {
  hookable: boolean
  bits?: number
  exe?: string
  /** Why the window cannot be hooked. */
  reason?: string
}

export interface HookThread {
  key: string
  /** The hook's name: an engine's, or a Windows API's for the generic hooks. */
  name: string
  hookcode: string
  /** The thread's latest text, its last 160 characters. */
  preview: string
  count: number
  /** One of the generic Windows API hooks rather than an engine hook. */
  generic: boolean
  selected: boolean
}

export type HookPhase = 'idle' | 'starting' | 'downloading' | 'attaching' | 'hooked' | 'ended' | 'failed'

export interface HookStatus {
  supported: boolean
  phase: HookPhase
  detail?: string | null
  sourceId?: string
  exe?: string | null
  pids?: number[]
  engine?: { id: string; name: string; version: string } | null
  download?: { done: number; total: number } | null
  selected?: string | null
  selectedBy?: 'saved' | 'auto' | 'manual' | null
  /** Why no thread has been chosen automatically yet. */
  pickNote?: string | null
  /** Why the first engine was given up for the one in use. */
  fallback?: string | null
  threads: HookThread[]
}

export const IDLE: HookStatus = { supported: false, phase: 'idle', threads: [] }

export const texthookTargets = (sourceIds: string[]): Promise<Record<string, HookTarget>> =>
  invoke<Record<string, HookTarget>>('texthook_targets', { sourceIds })
export const texthookStart = (sourceId: string, observerEngine?: string | null): Promise<HookStatus> =>
  invoke<HookStatus>('texthook_start', { sourceId, observerEngine: observerEngine ?? null })
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
