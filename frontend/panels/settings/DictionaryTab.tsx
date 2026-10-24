/**
 * Settings → Dictionary: which dictionary engine looks words up (`DictionaryChooser`, in the shape
 * of the OCR engine chooser), and that engine's own settings in its panel. Yomitan, Hachidori and
 * 10ten keep their dictionaries and options in their own settings pages (the `dictionary`
 * panel); the Yomitan API (Kimochi's own pop-up over the Yomitan in the user's browser) is set up
 * here: its helper and connection (`YomitanApiStatusRows`, and the setup wizard in a dialog, which
 * opens on its own when the Yomitan API is chosen and does not answer within a couple of seconds),
 * its address, pop-up size and audio. Anki is its
 * own page (AnkiTab), for every engine; the engines' panels link to it.
 *
 * Choosing an engine saves `yomitanSettings.popupType`, writes the document-start mirror
 * (`localStorage['kimochi.dictionaryEngine']`) and asks native to reload the reader windows
 * (`dictionary_engine_apply`), whose injected host scripts then install the new engine. The main
 * window is one of those (it runs lookups over the transcript), and this page is a view inside
 * it, so the page records where it is first (`rememberEngineSwitch`); the reloaded window opens
 * straight back onto it and says "Now using …". The separate Settings window hosts no engine and
 * is not reloaded; it says "Reloading the reader windows…" instead. The Yomitan API installs no
 * host (`hostEngineOf`), so moving to or from it reloads the reader windows like any other switch.
 * See DICTIONARY_ENGINES.md §2 and §8.
 *
 * Engines are downloaded on demand (EXTENSION_DOWNLOADS.md §2, UI). Choosing one that is not
 * downloaded asks first ("Download 10ten?"), starts the download and records a PENDING switch;
 * nothing is saved, so the engine in use is untouched while it downloads, and an offline failure
 * leaves everything as it was, with Retry. When the download is ready and the switch is still
 * pending, it is made exactly as above. If this page is closed meanwhile, the download finishes
 * in Rust and the engine simply offers "Use <name>" next time.
 */
import { useState, type ReactNode } from 'react'
import {
  Button,
  Callout,
  ConfirmDialog,
  Input,
  isComposing,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubgroup,
  Slider,
  Switch
} from '@kit'
import { DEFAULT_YOMITAN_API_URL } from '@ui/yomitan-api-setup'
import { YomitanApiSetupDialog, YomitanApiStatusRows } from '../../components/YomitanApiSetup'
import { nativeError } from '../../bridge/tauri'
import {
  DICTIONARY_ENGINES,
  openDictionarySettings,
  type DictionaryEngine
} from '../../bridge/dictionaryEngine'
import { describeUrlRestriction } from '../../bridge/yomitan'
import { setSetting } from '../../bridge/settings'
import { clearAudioCache } from '@texthooker/lib/audio'
import { updateSettings } from '@texthooker/lib/settings'
import type { Settings } from '@texthooker/lib/types'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { NumberField } from './fields'
import { DictionaryChooser } from './DictionaryChooser'
import { useDictionarySwitch } from './useDictionarySwitch'
import { DictionaryReadiness } from '../../components/DictionaryReadiness'
import { useDictionaryReadiness } from '../../bridge/dictionaryReadiness'

export function DictionaryTab(): ReactNode {
  const {
    yomitanSettings,
    setYomitanSettings,
    apiUrl,
    active,
    pending,
    asking,
    dismissAsking,
    prompt,
    confirmDownload,
    choose,
    reloading,
    applyError,
    switchedTo,
    setupOpen,
    setSetupOpen
  } = useDictionarySwitch('settings')
  const runtime = useDictionaryReadiness(active)

  const renderSettings = (engine: DictionaryEngine, inUse: boolean): ReactNode => {
    if (engine !== 'custom-api') {
      const name = DICTIONARY_ENGINES[engine].name
      return (
        <>
          <div className="dictionary-engine-action">
            {/* Not downloaded: the panel's download block above says so already. */}
            {inUse && (runtime.download === null || runtime.download === 'ready') && (
              <DictionaryReadiness engine={engine} />
            )}
            <div className="engine-setting-text">
              <span className="engine-setting-label">{name} settings</span>
              <span className="k-description">
                {!inUse
                  ? `${name}'s own settings open here once it is the active engine.`
                  : runtime.view.settingsAvailable
                    ? `Dictionaries, scanning and lookups are set up in ${name}'s own settings.`
                    : runtime.download !== null && runtime.download !== 'ready'
                      ? `${name}'s own settings open here once it is downloaded.`
                      : `${name}'s own settings open here once it has started.`}
              </span>
            </div>
            {inUse && runtime.view.settingsAvailable && (
              <Button
                size="sm"
                onClick={() => {
                  openDictionarySettings().catch((error) =>
                    console.error(`Open ${name} settings failed:`, nativeError(error).message)
                  )
                }}
              >
                Open {name} settings
              </Button>
            )}
          </div>
          {inUse && <AnkiLink engine={engine} />}
        </>
      )
    }
    return (
      <>
        <SettingsSection title="Your browser's Yomitan" grouped>
          <YomitanApiStatusRows url={apiUrl} active={!setupOpen} onSetUp={() => setSetupOpen(true)} />
          <ApiAddressRow
            value={yomitanSettings.customApiUrl}
            onSave={(value) => void setYomitanSettings({ ...yomitanSettings, customApiUrl: value })}
          />
        </SettingsSection>
        <WithReaderSettings>
          {(settings) => <KimochiPopupSections settings={settings} />}
        </WithReaderSettings>
      </>
    )
  }

  return (
    <SettingsPage title="Dictionary" description="The pop-up that shows definitions when you look up a word.">
      <SettingsSection title="Engine" grouped={false}>
        <ConfirmDialog
          open={asking !== null}
          onOpenChange={(open) => {
            if (!open) dismissAsking()
          }}
          title={prompt?.title ?? ''}
          description={prompt?.description}
          confirmLabel="Download"
          onConfirm={confirmDownload}
          dismissOnOutsideClick
        />
        <YomitanApiSetupDialog open={setupOpen} onOpenChange={setSetupOpen} url={apiUrl} />
        <DictionaryChooser
          active={active}
          pending={pending}
          onChoose={(engine) => void choose(engine)}
          renderSettings={renderSettings}
          status={
            applyError ? (
              <Callout tone="danger">{applyError}</Callout>
            ) : reloading === 'self' ? (
              <span role="status">Switching to {DICTIONARY_ENGINES[active].name}…</span>
            ) : reloading === 'others' ? (
              <span role="status">Reloading the reader windows…</span>
            ) : switchedTo && switchedTo === active ? (
              <Callout tone="ok" className="dictionary-chooser-switched">
                Now using {DICTIONARY_ENGINES[switchedTo].name}. The reader windows reloaded with it.
              </Callout>
            ) : null
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

/**
 * The Yomitan API's address, saved when the field is left or Enter is pressed (not on every
 * keystroke, which would check every half-typed address and rewrite the setting each time). An
 * address the API check would refuse stays in the field with the reason, unsaved.
 */
function ApiAddressRow({ value, onSave }: { value: string; onSave: (value: string) => void }): ReactNode {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  // A change saved elsewhere (another window, Sync) replaces the field.
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
    setError(null)
  }
  const save = (raw: string): void => {
    const next = raw.trim()
    const problem = next ? describeUrlRestriction(next) : null
    setError(problem)
    if (problem) return
    setDraft(next)
    if (next !== value) onSave(next)
  }
  return (
    <>
      <SettingsRow
        stacked
        label="API address"
        controlId="dictionary-api-url"
        description={`Where the helper serves the Yomitan API. Leave it empty for the default, ${DEFAULT_YOMITAN_API_URL}.`}
      >
        <div className="settings-url">
          <Input
            id="dictionary-api-url"
            mono
            value={draft}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
            }}
            onBlur={(e) => save(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isComposing(e)) save(e.currentTarget.value)
            }}
            placeholder={DEFAULT_YOMITAN_API_URL}
          />
        </div>
      </SettingsRow>
      {error && (
        <div className="settings-note">
          <Callout tone="warn">{error}</Callout>
        </div>
      )}
    </>
  )
}

/** Everything that only applies to the Yomitan API (Kimochi's own pop-up). */
function KimochiPopupSections({ settings }: { settings: Settings }): ReactNode {
  const volume = Math.round(settings.audioVolume * 100)
  return (
    <div className="texthooker dictionary-engine-sections">
      <SettingsSection title="Pop-up size">
        <SettingsRow label="Width" controlId="dictionary-pop-w" description="In pixels, 280 to 900.">
          <NumberField
            id="dictionary-pop-w"
            value={settings.popoverWidth}
            min={280}
            max={900}
            step={10}
            fallback={480}
            onCommit={(v) => void updateSettings({ popoverWidth: v })}
          />
        </SettingsRow>
        <SettingsRow label="Height" controlId="dictionary-pop-h" description="In pixels, 200 to 800.">
          <NumberField
            id="dictionary-pop-h"
            value={settings.popoverHeight}
            min={200}
            max={800}
            step={10}
            fallback={360}
            onCommit={(v) => void updateSettings({ popoverHeight: v })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Audio">
        <SettingsRow
          label="Fetch word audio"
          controlId="dictionary-audio"
          description="Pulls audio from the Yomitan API with each lookup."
        >
          <Switch
            id="dictionary-audio"
            checked={settings.audioEnabled}
            onCheckedChange={(v) => {
              if (!v) clearAudioCache()
              void updateSettings({ audioEnabled: v })
            }}
          />
        </SettingsRow>
        {settings.audioEnabled ? (
          <SettingsSubgroup>
            <SettingsRow label="Play on lookup" controlId="dictionary-autoplay">
              <Switch
                id="dictionary-autoplay"
                checked={settings.audioAutoplay}
                onCheckedChange={(v) => void updateSettings({ audioAutoplay: v })}
              />
            </SettingsRow>
            <SettingsRow label="Volume">
              <div className="settings-slider">
                <Slider
                  aria-label="Volume"
                  value={[volume]}
                  min={0}
                  max={100}
                  step={5}
                  onValueChange={(values) => void updateSettings({ audioVolume: values[0] / 100 })}
                />
                <span className="settings-slider-value k-num">{volume}%</span>
              </div>
            </SettingsRow>
          </SettingsSubgroup>
        ) : null}
      </SettingsSection>

      <AnkiLink />
    </div>
  )
}

/** The way to Settings → Anki, where each engine's way of adding cards is (and the Yomitan API's AnkiConnect). */
function AnkiLink({ engine }: { engine?: DictionaryEngine }): ReactNode {
  const description =
    engine === 'tenten'
      ? '10ten does not add Anki cards; Settings → Anki says which dictionaries do.'
      : engine
        ? `How ${DICTIONARY_ENGINES[engine].name} adds Anki cards is in Settings → Anki.`
        : 'The AnkiConnect connection, and the deck, note type and fields of the cards this pop-up adds, are in Settings → Anki.'
  const open = (): void => {
    setSetting('settingsActiveTab', 'anki').catch((error) =>
      console.error('Open Settings → Anki failed:', nativeError(error).message)
    )
  }
  if (engine) {
    return (
      <div className="dictionary-engine-action">
        <div className="engine-setting-text">
          <span className="engine-setting-label">Anki cards</span>
          <span className="k-description">{description}</span>
        </div>
        <Button size="sm" onClick={open}>
          Open Anki settings
        </Button>
      </div>
    )
  }
  return (
    <SettingsSection title="Anki">
      <SettingsRow label="Anki cards" description={description}>
        <Button size="sm" onClick={open}>
          Open Anki settings
        </Button>
      </SettingsRow>
    </SettingsSection>
  )
}
