/**
 * What a switch waiting for its download ("Use when downloaded") means, under the dictionary
 * chooser in Settings → Dictionary and onboarding's engine step: the download carries on in the
 * background (native owns it, `bridge/dictionarySwitch.ts`), the engine is switched to once it is
 * ready, and until then the engine in use goes on looking words up. While there is one in use,
 * "Keep using <it>" forgets the switch (the download still finishes, and the engine is then
 * offered as "Use <name>").
 */
import type { ReactNode } from 'react'
import { Callout } from '@kit'
import { DICTIONARY_ENGINES, type DictionaryEngine } from '../../bridge/dictionaryEngine'
import { useExtensionStatus } from '../../bridge/extensions'
import { downloadEngineFor } from '@ui/extension-download'
import { pendingSwitchLine } from '@ui/engine-chooser'
import './dictionary-chooser.css'

export function PendingSwitchNote({
  engine,
  saved,
  onKeepCurrent
}: {
  /** The engine waiting for its download. */
  engine: DictionaryEngine
  /** The engine in use now (the saved one). */
  saved: DictionaryEngine
  onKeepCurrent: () => void
}): ReactNode {
  const savedNeeds = downloadEngineFor(saved)
  const savedStatus = useExtensionStatus(savedNeeds)
  // The saved engine looks words up meanwhile only when it can run (a first run has none yet).
  const current = saved !== engine && (savedNeeds === null || savedStatus?.state === 'ready') ? saved : null
  return (
    <Callout tone="neutral" className="dictionary-pending-note">
      {pendingSwitchLine(DICTIONARY_ENGINES[engine].name, current === null ? null : DICTIONARY_ENGINES[current].name)}
      {current !== null && (
        <>
          {' '}
          <button type="button" className="k-link" onClick={onKeepCurrent}>
            Keep using {DICTIONARY_ENGINES[current].name}
          </button>
        </>
      )}
    </Callout>
  )
}
