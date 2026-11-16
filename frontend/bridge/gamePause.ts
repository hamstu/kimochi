/**
 * "Pause the game while reading" (src-tauri/src/game_pause): the settings row's state, the escape
 * hatch, and the one-time notice when a game cannot be paused. Commands and events are in
 * COMMANDS.md.
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type GamePauseRefusalKind =
  | 'unsupported'
  | 'noPid'
  | 'notFound'
  | 'protected'
  | 'antiCheat'
  | 'elevated'
  | 'denylisted'
  | 'permissionDenied'
  | 'other'

export interface GamePauseRefusal {
  kind: GamePauseRefusalKind
  detail: string
}

export interface GamePauseStatus {
  enabled: boolean
  phase: 'idle' | 'pausing' | 'paused' | 'resuming'
  holds: ('lookup' | 'navigation' | 'regionEditor')[]
  game?: string
  processes: number
  mechanism?: string
  refusal?: GamePauseRefusal
}

export interface GamePauseInfo {
  capability: { supported: boolean; backend: string; note?: string }
  enabled: boolean
  status: GamePauseStatus | null
}

export interface GamePauseNotice {
  game: string
  title?: string
  kind: GamePauseRefusalKind
  detail: string
}

export const gamePauseStatus = (): Promise<GamePauseInfo> => invoke<GamePauseInfo>('game_pause_status')
export const gamePauseResumeAll = (): Promise<unknown> => invoke('game_pause_resume_all')

/** What the reader is told when a game could not be paused. */
export function refusalText(kind: GamePauseRefusalKind): string {
  switch (kind) {
    case 'unsupported':
      return 'Pausing games is not available on this system yet.'
    case 'noPid':
      return 'Kimochi could not tell which program the game is. Choose its window as the source.'
    case 'notFound':
      return 'The game’s program could not be found.'
    case 'protected':
      return 'This game is protected by the system and cannot be paused.'
    case 'antiCheat':
      return 'This game uses anti-cheat, so Kimochi leaves it running.'
    case 'elevated':
      return 'This game runs with more rights than Kimochi (as administrator or another user).'
    case 'denylisted':
      return 'This program is part of the system and is never paused.'
    case 'permissionDenied':
      return 'The system did not let Kimochi pause this game.'
    default:
      return 'This game could not be paused.'
  }
}

/** The status row's live state: fetched once, then kept current by the `game-pause` event. */
export function useGamePause(): GamePauseInfo | null {
  const [info, setInfo] = useState<GamePauseInfo | null>(null)
  useEffect(() => {
    let alive = true
    void gamePauseStatus()
      .then((value) => alive && setInfo(value))
      .catch(() => undefined)
    const off = listen<GamePauseStatus>('game-pause', (event) => {
      setInfo((current) => (current ? { ...current, enabled: event.payload.enabled, status: event.payload } : current))
    })
    return () => {
      alive = false
      void off.then((unlisten) => unlisten())
    }
  }, [])
  return info
}

/** The latest refusal notice (one per game per run, from native), until dismissed. */
export function useGamePauseNotice(): [GamePauseNotice | null, () => void] {
  const [notice, setNotice] = useState<GamePauseNotice | null>(null)
  useEffect(() => {
    const off = listen<GamePauseNotice>('game-pause-notice', (event) => setNotice(event.payload))
    return () => void off.then((unlisten) => unlisten())
  }, [])
  return [notice, () => setNotice(null)]
}
