/**
 * niri without a shortcuts portal, and its config doesn't include Kimochi's binds yet: say so once,
 * with the same "Add to my niri config" as Settings → Shortcuts & Controls. Dismissed for good with
 * "Not now" (`niriShortcutsPromptDismissed`); the Settings section stays.
 */
import type { JSX } from 'react'
import { Callout } from '@kit'
import { useSetting } from '../bridge/useSetting'
import { useNiriInclude, useNiriShortcuts } from '../bridge/niriShortcuts'
import { openSettings } from '../bridge/tauri'

export function NiriShortcutsNotice(): JSX.Element | null {
  const setup = useNiriShortcuts()
  const [dismissed, setDismissed] = useSetting<boolean>('niriShortcutsPromptDismissed', false)
  const { busy, error, add } = useNiriInclude()
  if (!setup || setup.status !== 'needsSetup' || dismissed) return null
  return (
    <Callout tone="warn" className="src-notice">
      <span>
        {error ? (
          <>
            <strong>Couldn&rsquo;t add Kimochi&rsquo;s shortcuts to niri.</strong> {error}
          </>
        ) : (
          <>
            <strong>Shortcuts need one line in your niri config.</strong> Kimochi keeps its shortcuts in {setup.binds};
            niri runs them once your config includes it.
          </>
        )}
      </span>
      {setup.blocked || error ? (
        <button type="button" className="k-link src-notice-link" onClick={() => void openSettings('controls')}>
          Show me how
        </button>
      ) : (
        <button type="button" className="k-link src-notice-link" disabled={busy} onClick={add}>
          {busy ? 'Adding…' : 'Add to my niri config'}
        </button>
      )}
      <button type="button" className="k-link src-notice-link" onClick={() => void setDismissed(true)}>
        Not now
      </button>
    </Callout>
  )
}
