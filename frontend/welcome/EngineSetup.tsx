/**
 * Onboarding's dictionary-engine step. Kimochi ships no dictionary engine (EXTENSION_DOWNLOADS.md):
 * a first run chooses one here (Yomitan recommended), downloads it with the same progress block as
 * the OCR models (pause, resume, retry, cancel), and can continue once it is ready. Offline, the
 * failure is shown with Retry, and another engine can be picked instead. Skipping is possible but
 * explicit, behind a warning that nothing will look words up until an engine is chosen in
 * Settings → Dictionary.
 *
 * Continuing with an engine other than the one the setting names saves it, mirrors it and asks
 * native to reload the reader windows (`dictionary_engine_apply`), this one included: the hash
 * route is moved to the next step first, so the reload lands there. The engine the setting already
 * names (Yomitan, by default) needs none of that: native moves the windows to it the moment its
 * download is ready.
 */
import { useState, type JSX } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Callout, ConfirmDialog } from "@kit";
import { nativeError } from "../bridge/tauri";
import { setSetting } from "../bridge/settings";
import {
  DICTIONARY_ENGINES,
  applyDictionaryEngine,
  dictionaryEngineOf,
  mirrorDictionaryEngine,
  popupTypeOf,
  useDictionaryEngine,
} from "../bridge/dictionaryEngine";
import { useExtensionControls, useExtensionStatus } from "../bridge/extensions";
import { formatBytes } from "@ui/model-download";
import {
  EXTENSION_ENGINES,
  downloadButtonLabel,
  type ExtensionEngine,
} from "@ui/extension-download";
import { ModelDownload } from "../panels/settings/ModelDownload";
import style from "./EngineSetup.module.css";

/** Where onboarding goes once an engine is ready: its own setup step. */
export const AFTER_ENGINE = "/dictionaries";
/** Where a skip goes: past the dictionary steps. */
export const AFTER_SKIP = "/practice";

function EngineOption({
  engine,
  chosen,
  onChoose,
}: {
  engine: ExtensionEngine;
  chosen: boolean;
  onChoose: () => void;
}): JSX.Element {
  const info = DICTIONARY_ENGINES[engine];
  const status = useExtensionStatus(engine);
  const size = status && status.overallTotal > 0 ? formatBytes(status.overallTotal) : null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      className={style.option}
      data-chosen={chosen || undefined}
      onClick={onChoose}
    >
      <span className={style.optionHead}>
        <span className={style.radio} aria-hidden />
        <span className={style.name}>{info.name}</span>
        {engine === "yomitan" && <Badge tone="accent">Recommended</Badge>}
        <span className={style.size}>
          {status?.state === "ready" ? "Downloaded" : size}
        </span>
      </span>
      <span className={style.tagline}>{info.tagline}</span>
      <span className={style.description}>{info.description}</span>
    </button>
  );
}

export default function EngineSetup(): JSX.Element {
  const navigate = useNavigate();
  const [, settings] = useDictionaryEngine();
  const saved = dictionaryEngineOf(settings.popupType);
  const savedDownload: ExtensionEngine = saved === "custom-api" ? "yomitan" : saved;
  const [chosen, setChosen] = useState<ExtensionEngine>(savedDownload);
  // The setting arrives after the first render: follow it until the user picks.
  const [touched, setTouched] = useState(false);
  if (!touched && chosen !== savedDownload) setChosen(savedDownload);
  const controls = useExtensionControls(chosen);
  const status = controls.status;
  const ready = status?.state === "ready";
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [askSkip, setAskSkip] = useState(false);

  const choose = (engine: ExtensionEngine): void => {
    setError(null);
    setTouched(true);
    setChosen(engine);
  };

  const proceed = async (): Promise<void> => {
    setError(null);
    if (savedDownload === chosen) {
      // Native already runs (or is moving the windows to) this engine.
      void navigate(AFTER_ENGINE);
      return;
    }
    setSwitching(true);
    try {
      await setSetting("yomitanSettings", {
        ...settings,
        popupType: popupTypeOf(chosen),
      });
    } catch (caught) {
      setSwitching(false);
      setError(`Could not save your choice: ${nativeError(caught).message}`);
      return;
    }
    mirrorDictionaryEngine(chosen);
    // Before the reload, so it lands on the next step.
    void navigate(AFTER_ENGINE);
    try {
      await applyDictionaryEngine();
    } catch (caught) {
      setSwitching(false);
      setError(
        `Saved, but the reader windows could not be reloaded: ${nativeError(caught).message}. Restart Kimochi to finish switching.`,
      );
    }
  };

  const name = DICTIONARY_ENGINES[chosen].name;
  return (
    <section aria-labelledby="engine-setup-title" className={style.root}>
      <h1 id="engine-setup-title">Choose a pop-up dictionary</h1>
      <p>
        Kimochi looks words up with a pop-up dictionary engine. None is included
        in Kimochi&apos;s own download, so choose one now and Kimochi fetches it
        from its official release. You can switch at any time in Settings →
        Dictionary.
      </p>
      <div role="radiogroup" aria-label="Dictionary engine" className={style.options}>
        {EXTENSION_ENGINES.map((engine) => (
          <EngineOption
            key={engine}
            engine={engine}
            chosen={engine === chosen}
            onChoose={() => choose(engine)}
          />
        ))}
      </div>
      {status && !ready && (
        <ModelDownload controls={controls} emphasis label="Download" />
      )}
      {status?.state === "failed" && (
        <p className="k-description">
          Check your connection and press Retry, or choose another engine.
        </p>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
      <div className={style.actions}>
        {ready || !status ? (
          <Button
            variant="primary"
            disabled={switching}
            onClick={() => void proceed()}
          >
            {switching ? `Switching to ${name}…` : `Continue with ${name}`}
          </Button>
        ) : status.state === "absent" ? (
          <Button
            variant="primary"
            disabled={controls.pending !== null}
            onClick={() => controls.run("download")}
          >
            {downloadButtonLabel(status)}
          </Button>
        ) : (
          <Button variant="primary" disabled>
            Continue when {name} is ready
          </Button>
        )}
        <Button variant="ghost" onClick={() => setAskSkip(true)}>
          Skip for now
        </Button>
      </div>
      <ConfirmDialog
        open={askSkip}
        onOpenChange={setAskSkip}
        title="Continue without a dictionary?"
        description="Nothing will look words up until you choose and download a dictionary in Settings → Dictionary. Scanning and the Log still work."
        confirmLabel="Skip"
        tone="danger"
        onConfirm={() => {
          setAskSkip(false);
          void navigate(AFTER_SKIP);
        }}
      />
    </section>
  );
}
