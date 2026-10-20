/**
 * Onboarding's dictionary-engine step. Kimochi ships no dictionary engine (EXTENSION_DOWNLOADS.md):
 * a first run chooses one here (Built-in Yomitan recommended) with the same list-and-panel chooser
 * as Settings → Dictionary (`DictionaryChooser`), as the OCR step uses the OCR one. Choosing goes
 * through `useDictionarySwitch`, as there: an engine that is downloaded is switched to at once; one
 * that is not is downloaded from its panel (the button names the size, so it is not asked about
 * again) and switched to once ready. Switching to an engine with another host reloads the reader
 * windows, this one included; the hash route keeps it on this step, now showing the new engine.
 *
 * The action bar carries the step's next move: Download for the chosen engine when it is not yet
 * downloaded, Continue once it is ready (disabled while it downloads or switches), and Skip beside
 * it. Skipping is possible but explicit, behind a warning that nothing will look words up until an
 * engine is chosen in Settings → Dictionary. Offline, the failure is shown with Retry, and another
 * engine can be picked instead.
 *
 * The Yomitan API is offered too. It needs Yomitan's download (for splitting text into words), and
 * its setup step is the Yomitan API wizard. Moving between Built-in Yomitan and the Yomitan API
 * reloads nothing: they share the Yomitan host.
 */
import { useEffect, useState, type JSX } from 'react'
import { useNavigate } from 'react-router'
import { Button, Callout, ConfirmDialog } from '@kit'
import { DICTIONARY_ENGINES } from '../bridge/dictionaryEngine'
import { useExtensionControls } from '../bridge/extensions'
import { downloadButtonLabel, downloadEngineFor } from '@ui/extension-download'
import { DictionaryChooser } from '../panels/settings/DictionaryChooser'
import { useDictionarySwitch } from '../panels/settings/useDictionarySwitch'
import Step from './Step'
import { StepActions } from './StepActions'

/** Where onboarding goes once an engine is ready: its own setup step. */
export const AFTER_ENGINE = '/dictionaries'
/** Where a skip goes: past the dictionary steps. */
export const AFTER_SKIP = '/done'

export default function EngineSetup(): JSX.Element {
  const navigate = useNavigate()
  const { active, saved, pending, asking, confirmDownload, choose, reloading, applyError } =
    useDictionarySwitch('settings')
  // The panel's button already says "Download · 15 MB": that click is the answer.
  useEffect(() => {
    if (asking) confirmDownload()
  }, [asking, confirmDownload])
  // The engine the bar moves on with: one waiting for its download, else the one in use.
  const target = pending ?? active
  const controls = useExtensionControls(downloadEngineFor(target))
  const status = controls.status
  const ready = status === null || status.state === 'ready'
  const switching = reloading !== null || active !== saved || pending !== null
  const [askSkip, setAskSkip] = useState(false)
  const name = DICTIONARY_ENGINES[target].name

  return (
    <Step
      title="Choose a pop-up dictionary"
      lede="Kimochi looks words up with a pop-up dictionary engine. Choose one and Kimochi downloads it from its official release. You can switch at any time in Settings → Dictionary."
    >
      <DictionaryChooser
        active={active}
        pending={pending}
        recommended="yomitan"
        onChoose={(engine) => void choose(engine)}
        renderSettings={() => null}
        status={
          applyError ? (
            <Callout tone="danger">{applyError}</Callout>
          ) : reloading ? (
            <span role="status">Switching to {DICTIONARY_ENGINES[active].name}…</span>
          ) : null
        }
      />
      {status?.state === 'failed' && (
        <p className="k-description">Check your connection and press Retry, or choose another engine.</p>
      )}
      {controls.error && <Callout tone="danger">{controls.error}</Callout>}

      <StepActions>
        <Button variant="ghost" onClick={() => setAskSkip(true)}>
          Skip for now
        </Button>
        {status?.state === 'absent' ? (
          <Button
            variant="primary"
            disabled={controls.pending !== null}
            onClick={() => controls.run('download')}
          >
            {downloadButtonLabel(status)}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!ready || switching}
            onClick={() => void navigate(AFTER_ENGINE)}
          >
            {ready && switching ? `Switching to ${name}…` : 'Continue'}
          </Button>
        )}
      </StepActions>
      <ConfirmDialog
        open={askSkip}
        onOpenChange={setAskSkip}
        title="Continue without a dictionary?"
        description="Nothing will look words up until you choose and download a dictionary in Settings → Dictionary. Scanning and the Log still work."
        confirmLabel="Skip"
        tone="danger"
        onConfirm={() => {
          setAskSkip(false)
          void navigate(AFTER_SKIP)
        }}
      />
    </Step>
  )
}
