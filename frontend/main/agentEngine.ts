/**
 * Agent scripts on the game's card (AgentHook.tsx): how a script and its download are named, and
 * which engine a session is on.
 */
import { texthookEngine, type AgentScript, type HookEngineChoice, type HookStatus } from '../bridge/textHook'
import { updateHookGame } from './hookGames'

const PLATFORMS: Record<string, string> = {
  switch: 'Switch',
  psp: 'PSP',
  ps2: 'PS2',
  ps3: 'PS3',
  vita: 'PS Vita',
  '3ds': '3DS',
  pc: 'PC',
  pc98: 'PC-98',
  android: 'Android'
}

export const platformName = (platform: string): string => PLATFORMS[platform] ?? platform

/** A download's size, as the sidebar says sizes: `27 MB`, `1.9 MB`. */
export function megabytes(bytes: number): string {
  const mb = bytes / 1_000_000
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** The script, as the card names it: `CLANNAD · Switch`. */
export const scriptLine = (script: AgentScript): string => `${script.title} · ${platformName(script.platform)}`

/** The engine a session is on, as the switch shows it: the one running, else the one it starts with. */
export function currentEngine(status: HookStatus): HookEngineChoice {
  const running = status.engine?.id
  if (running) return running === 'agent' ? 'agent' : 'luna'
  return status.engines?.[0] === 'luna' ? 'luna' : 'agent'
}

/** Switches the hooked game between its Agent script and LunaHook, and keeps the choice for it. */
export function chooseEngine(status: HookStatus, engine: HookEngineChoice): void {
  if (currentEngine(status) === engine) return
  void texthookEngine(engine).catch(() => {})
  const exe = status.exe
  if (exe) void updateHookGame(exe, (game) => ({ ...game, exe: game.exe ?? exe, engine })).catch(() => {})
}
