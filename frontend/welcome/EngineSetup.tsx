/**
 * Onboarding's dictionary-engine step. Kimochi ships no dictionary engine (EXTENSION_DOWNLOADS.md):
 * a first run chooses one here (Yomitan recommended), downloads it with the same progress block as
 * the OCR models (pause, resume, retry, cancel), and can continue once it is ready. Offline, the
 * failure is shown with Retry, and another engine can be picked instead. Skipping is possible but
 * explicit, behind a warning that nothing will look words up until an engine is chosen in
 * Settings → Dictionary.
 *
 * The action bar carries the step's next move: Download for an engine not yet downloaded,
 * Continue once it is ready (disabled while it downloads), and Skip beside it.
 *
 * Continuing with an engine other than the one the setting names saves it, mirrors it and asks
 * native to reload the reader windows (`dictionary_engine_apply`), this one included: the hash
 * route is moved to the next step first, so the reload lands there. The engine the setting already
 * names (Yomitan, by default) needs none of that: native moves the windows to it the moment its
 * download is ready.
 */
import { useState, type JSX } from 'react'
import { useNavigate } from 'react-router'
import { Badge, Button, Callout, ChoiceGroup, ConfirmDialog } from '@kit'
import { nativeError } from '../bridge/tauri'
import { setSetting } from '../bridge/settings'
import {
  DICTIONARY_ENGINES,
  applyDictionaryEngine,
  dictionaryEngineOf,
  mirrorDictionaryEngine,
  popupTypeOf,
  useDictionaryEngine
} from '../bridge/dictionaryEngine'
import { useExtensionControls, useExtensionStatus } from '../bridge/extensions'
import { formatBytes } from '@ui/model-download'
import { EXTENSION_ENGINES, downloadButtonLabel, type ExtensionEngine } from '@ui/extension-download'
import { ModelDownload } from '../panels/settings/ModelDownload'
import Step from './Step'
import { StepActions } from './StepActions'
import style from './WelcomeApp.module.css'

/** Where onboarding goes once an engine is ready: its own setup step. */
export const AFTER_ENGINE = '/dictionaries'
/** Where a skip goes: past the dictionary steps. */
export const AFTER_SKIP = '/done'

/** The size, or "Downloaded", at the end of an engine's card. */
function EngineSize({ engine }: { engine: ExtensionEngine }): JSX.Element | null {
  const status = useExtensionStatus(engine)
  if (!status) return null
  const text =
    status.state === 'ready'
      ? 'Downloaded'
      : status.overallTotal > 0
        ? formatBytes(status.overallTotal)
        : null
  return text ? <span className={style.engineSize}>{text}</span> : null
}

export default function EngineSetup(): JSX.Element {
  const navigate = useNavigate()
  const [, settings] = useDictionaryEngine()
  const saved = dictionaryEngineOf(settings.popupType)
  const savedDownload: ExtensionEngine = saved === 'custom-api' ? 'yomitan' : saved
  const [chosen, setChosen] = useState<ExtensionEngine>(savedDownload)
  // The setting arrives after the first render: follow it until the user picks.
  const [touched, setTouched] = useState(false)
  if (!touched && chosen !== savedDownload) setChosen(savedDownload)
  const controls = useExtensionControls(chosen)
  const status = controls.status
  const ready = status?.state === 'ready'
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [askSkip, setAskSkip] = useState(false)

  const choose = (engine: ExtensionEngine): void => {
    setError(null)
    setTouched(true)
    setChosen(engine)
  }

  const proceed = async (): Promise<void> => {
    setError(null)
    if (savedDownload === chosen) {
      // Native already runs (or is moving the windows to) this engine.
      void navigate(AFTER_ENGINE)
      return
    }
    setSwitching(true)
    try {
      await setSetting('yomitanSettings', { ...settings, popupType: popupTypeOf(chosen) })
    } catch (caught) {
      setSwitching(false)
      setError(`Could not save your choice: ${nativeError(caught).message}`)
      return
    }
    mirrorDictionaryEngine(chosen)
    // Before the reload, so it lands on the next step.
    void navigate(AFTER_ENGINE)
    try {
      await applyDictionaryEngine()
    } catch (caught) {
      setSwitching(false)
      setError(
        `Saved, but the reader windows could not be reloaded: ${nativeError(caught).message}. Restart Kimochi to finish switching.`
      )
    }
  }

  const info = DICTIONARY_ENGINES[chosen]
  const inProgress = status !== null && !ready && status.state !== 'absent'
  return (
    <Step
      title="Choose a pop-up dictionary"
      lede="Kimochi looks words up with a pop-up dictionary engine. Choose one and Kimochi downloads it from its official release. You can switch at any time in Settings → Dictionary."
    >
      <ChoiceGroup<ExtensionEngine>
        aria-label="Dictionary engine"
        className={style.engines}
        value={chosen}
        onValueChange={choose}
        options={EXTENSION_ENGINES.map((engine) => ({
          value: engine,
          label: (
            <>
              <span className={style.engineName}>{DICTIONARY_ENGINES[engine].name}</span>
              <EngineSize engine={engine} />
            </>
          ),
          detail: (
            <>
              {DICTIONARY_ENGINES[engine].tagline}
              {engine === 'yomitan' && (
                <Badge tone="accent" className={style.engineBadge}>
                  Recommended
                </Badge>
              )}
            </>
          )
        }))}
      />
      <p className={style.engineDescription}>{info.description}</p>
      {inProgress && <ModelDownload controls={controls} emphasis={false} label="Download" />}
      {status?.state === 'failed' && (
        <p className="k-description">Check your connection and press Retry, or choose another engine.</p>
      )}
      {!inProgress && controls.error && <Callout tone="danger">{controls.error}</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}

      <StepActions>
        <Button variant="ghost" onClick={() => setAskSkip(true)}>
          Skip for now
        </Button>
        {ready || !status ? (
          <Button variant="primary" disabled={switching} onClick={() => void proceed()}>
            {switching ? `Switching to ${info.name}…` : 'Continue'}
          </Button>
        ) : status.state === 'absent' ? (
          <Button
            variant="primary"
            disabled={controls.pending !== null}
            onClick={() => controls.run('download')}
          >
            {downloadButtonLabel(status)}
          </Button>
        ) : (
          <Button variant="primary" disabled>
            Continue
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
