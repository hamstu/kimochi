/**
 * Agent scripts in the Text hooking box (text_hook/agent): a script from the Agent collection that
 * knows where a game's text is, emulated console games above all.
 *
 * - While Text hooking is off for a game that has one, the box offers it, with what it would
 *   download the first time (Frida and the scripts). Using it turns Text hooking on with the script.
 * - While the game is hooked, a game with a script can switch between it and LunaHook, and the
 *   choice is kept for the game (`textHookerGames.<exe>.engine`).
 */
import type { ReactNode } from 'react'
import { Plug, ScrollText } from 'lucide-react'
import { Button, Segmented, Tooltip } from '@kit'
import type { AgentScript, HookEngineChoice, HookStatus } from '../bridge/textHook'
import { chooseEngine, currentEngine, megabytes, scriptLine } from './agentEngine'

const ABOUT =
  'A script written for this game reads its text from inside it, exactly where the game keeps it. Emulated console games too. If it cannot hook the game, LunaHook takes over.'

/** The offer under the switch while Text hooking is off. */
export function AgentOffer({ script, onUse }: { script: AgentScript; onUse: () => void }): ReactNode {
  const download = script.download > 0 ? megabytes(script.download) : null
  return (
    <div className="src-agent-offer">
      <ScrollText aria-hidden />
      <Tooltip content={ABOUT} side="bottom" delayDuration={300}>
        <div className="src-agent-offer-text" tabIndex={-1}>
          <span className="src-agent-offer-title">Agent script found</span>
          <span className="src-agent-offer-detail">
            {scriptLine(script)}
            {download && (
              <span className="k-num" title="Downloaded the first time (Frida and the scripts)">
                {' '}
                · {download}
              </span>
            )}
          </span>
        </div>
      </Tooltip>
      <Button size="sm" onClick={onUse}>
        Use
      </Button>
    </div>
  )
}

/** Agent script or LunaHook, for a hooked game that has a script. */
export function EngineSwitch({ status }: { status: HookStatus }): ReactNode {
  if (!status.agent) return null
  return (
    <Segmented<HookEngineChoice>
      aria-label="Hooked with"
      className="src-hook-engines"
      value={currentEngine(status)}
      onValueChange={(engine) => chooseEngine(status, engine)}
      options={[
        { value: 'agent', label: 'Agent script', icon: <ScrollText aria-hidden /> },
        { value: 'luna', label: 'LunaHook', icon: <Plug aria-hidden /> }
      ]}
    />
  )
}
