/**
 * Settings → Dictionary: which dictionary engine looks words up (`DictionaryChooser`, in the shape
 * of the OCR engine chooser), and that engine's own settings in its panel. Yomitan, Hachidori and
 * 10ten keep their dictionaries and options in their own settings pages (the `dictionary`
 * panel); Kimochi's pop-up (over a Yomitan API server) is set up here, including its Anki card
 * builder.
 *
 * Choosing an engine saves `yomitanSettings.popupType`, writes the document-start mirror
 * (`localStorage['kimochi.dictionaryEngine']`) and asks native to reload the reader windows
 * (`dictionary_engine_apply`), whose injected host scripts then install the new engine. The main
 * window is one of those (it runs lookups over the transcript), and this page is a view inside
 * it, so the page records where it is first (`rememberEngineSwitch`); the reloaded window opens
 * straight back onto it and says "Now using …". The separate Settings window hosts no engine and
 * is not reloaded; it says "Reloading the reader windows…" instead. Yomitan and Kimochi's pop-up
 * share the Yomitan host, so moving between those two reloads nothing. See DICTIONARY_ENGINES.md
 * §2 and §8.
 *
 * Engines are downloaded on demand (EXTENSION_DOWNLOADS.md §2, UI). Choosing one that is not
 * downloaded asks first ("Download 10ten?"), starts the download and records a PENDING switch;
 * nothing is saved, so the engine in use is untouched while it downloads, and an offline failure
 * leaves everything as it was, with Retry. When the download is ready and the switch is still
 * pending, it is made exactly as above. If this page is closed meanwhile, the download finishes
 * in Rust and the engine simply offers "Use this engine" next time.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Callout,
  ConfirmDialog,
  Input,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubgroup,
  Slider,
  StatusDot,
  Switch,
  type Tone
} from '@kit'
import type { YomitanSettings } from '../../vendor/shared-types'
import { API_URLS } from '../../vendor/shared-constants'
import { useSetting } from '../../bridge/useSetting'
import { setSetting } from '../../bridge/settings'
import { nativeError } from '../../bridge/tauri'
import {
  DICTIONARY_ENGINES,
  applyDictionaryEngine,
  dictionaryEngineOf,
  documentPlaceholder,
  hostEngineOf,
  mirrorDictionaryEngine,
  openDictionarySettings,
  popupTypeOf,
  type DictionaryEngine
} from '../../bridge/dictionaryEngine'
import { describeUrlRestriction, testApiConnection } from '../../bridge/yomitan'
import { AnkiSetup } from '@texthooker/components/AnkiSetup'
import { clearAudioCache } from '@texthooker/lib/audio'
import { updateSettings } from '@texthooker/lib/settings'
import type { Settings } from '@texthooker/lib/types'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { NumberField } from './fields'
import { DictionaryChooser } from './DictionaryChooser'
import { extensionAction, extensionStatus, type ExtensionStatus } from '../../bridge/extensions'
import { downloadEngineFor, extensionDownloadPrompt, normalizeExtensionStatus } from '@ui/extension-download'
import { onEvent } from '../../bridge/tauri'
import { engineSwitchRecord, forgetEngineSwitch, rememberEngineSwitch } from '../../main/engineSwitch'

type TestStatus = 'idle' | 'testing' | 'success' | 'error'

/** How long "Reloading the reader windows…" stays up after native has answered. */
const RELOAD_NOTE_MS = 2500
/** How long "Now using …" stays up after the reload a switch gave this window. */
const SWITCHED_NOTE_MS = 6000

/**
 * The engine this window was just reloaded into by a switch made here, while that is news. The
 * record is read once per document, so a later visit to this page does not announce it again.
 */
function justSwitchedTo(): DictionaryEngine | null {
  const record = engineSwitchRecord()
  return record && Date.now() - record.at < SWITCHED_NOTE_MS + 4000 ? record.engine : null
}

const STATUS_TONE: Record<TestStatus, Tone> = {
  idle: 'neutral',
  testing: 'warn',
  success: 'ok',
  error: 'danger'
}

const STATUS_LABEL: Record<TestStatus, string> = {
  idle: 'Not tested',
  testing: 'Testing',
  success: 'Connected',
  error: 'Connection failed'
}

export function DictionaryTab(): ReactNode {
  // Until the setting loads, the engine this document was (re)loaded for, not the shipped
  // default: after a switch the chooser's first frame already shows the new engine as active.
  const [switchedTo, setSwitchedTo] = useState<DictionaryEngine | null>(justSwitchedTo)
  const [yomitanSettings, setYomitanSettings] = useSetting<YomitanSettings>('yomitanSettings', {
    popupType: popupTypeOf(engineSwitchRecord()?.engine ?? documentPlaceholder()),
    customApiUrl: API_URLS.YOMITAN_FALLBACK
  })
  const [apiTestStatus, setApiTestStatus] = useState<TestStatus>('idle')
  const saved = dictionaryEngineOf(yomitanSettings.popupType)
  // The pick, shown as active from the click so the panel does not flash "Use this engine" while
  // the write goes out. Cleared once the setting agrees (or the write fails).
  const [picked, setPicked] = useState<DictionaryEngine | null>(null)
  const active = picked ?? saved
  // What this window does once native has the switch: 'self' when it is about to be reloaded
  // itself (the main window), 'others' when only the reader windows are.
  const [reloading, setReloading] = useState<'self' | 'others' | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)

  if (picked !== null && picked === saved) setPicked(null)

  // A switch waiting for its engine's download, and the question asked before starting one.
  const [pending, setPending] = useState<DictionaryEngine | null>(null)
  const [asking, setAsking] = useState<{ engine: DictionaryEngine; status: ExtensionStatus } | null>(null)

  useEffect(() => {
    if (!reloading) return
    const timer = setTimeout(() => setReloading(null), RELOAD_NOTE_MS)
    return () => clearTimeout(timer)
  }, [reloading])

  useEffect(() => {
    if (!switchedTo) return
    const timer = setTimeout(() => setSwitchedTo(null), SWITCHED_NOTE_MS)
    return () => clearTimeout(timer)
  }, [switchedTo])

  const commit = useCallback(
    async (engine: DictionaryEngine): Promise<void> => {
      setPicked(engine)
      setApplyError(null)
      setSwitchedTo(null)
      // Reset test status when leaving the Kimochi pop-up, as before.
      if (engine !== 'custom-api') setApiTestStatus('idle')
      try {
        // Through the settings client directly, not the hook's setter: that one reverts quietly
        // on failure, and a failed save must not go on to mirror and reload the windows.
        await setSetting('yomitanSettings', { ...yomitanSettings, popupType: popupTypeOf(engine) })
      } catch (error) {
        setPicked(null)
        setApplyError(`Could not save the dictionary engine: ${nativeError(error).message}`)
        return
      }
      mirrorDictionaryEngine(engine)
      // Yomitan and Kimochi's pop-up share a host, so moving between them reloads nothing: the
      // overlay switches live, as it always has.
      if (hostEngineOf(engine) === hostEngineOf(saved)) return
      // Before native reloads this window, so the reload comes back to this page.
      setReloading(rememberEngineSwitch(engine) ? 'self' : 'others')
      try {
        await applyDictionaryEngine()
      } catch (error) {
        forgetEngineSwitch()
        setReloading(null)
        setApplyError(
          `Saved, but the reader windows could not be reloaded: ${nativeError(error).message}. Restart Kimochi to switch engines.`
        )
      }
    },
    [yomitanSettings, saved]
  )

  // Choosing: an engine that can run is switched to at once; one that is not downloaded is asked
  // about (absent) or resumed (paused, failed) and switched to once ready.
  const ticket = useRef(0)
  const handleChoose = useCallback(
    async (engine: DictionaryEngine): Promise<void> => {
      const mine = ++ticket.current
      setApplyError(null)
      let status: ExtensionStatus | null = null
      try {
        status = await extensionStatus(downloadEngineFor(engine))
      } catch {
        // A backend without engine downloads: everything it has is bundled.
      }
      if (ticket.current !== mine) return
      if (!status || status.state === 'ready') {
        setPending(null)
        return commit(engine)
      }
      if (status.state === 'absent') {
        setAsking({ engine, status })
        return
      }
      setPending(engine === saved ? null : engine)
      if (status.state === 'paused' || status.state === 'failed') {
        extensionAction(status.engine, status.state === 'paused' ? 'resume' : 'retry').catch((error) =>
          setApplyError(`Could not download ${status.name}: ${nativeError(error).message}`)
        )
      }
    },
    [commit, saved]
  )

  const confirmDownload = useCallback((): void => {
    if (!asking) return
    const { engine, status } = asking
    setAsking(null)
    // The saved engine needs no switch: native moves the windows to it once it is downloaded.
    setPending(engine === saved ? null : engine)
    extensionAction(status.engine, 'download').catch((error) => {
      setPending(null)
      setApplyError(`Could not download ${status.name}: ${nativeError(error).message}`)
    })
  }, [asking, saved])

  // The pending switch is made when its download is ready; a cancelled download drops it.
  useEffect(() => {
    if (!pending) return
    const needs = downloadEngineFor(pending)
    let done = false
    const settle = (status: ExtensionStatus | null): void => {
      if (done || status?.engine !== needs) return
      if (status.state === 'ready') {
        done = true
        setPending(null)
        void commit(pending)
      } else if (status.state === 'absent') {
        done = true
        setPending(null)
      }
    }
    let unlisten: (() => void) | null = null
    let closed = false
    onEvent<unknown>('extension-download', (payload) => settle(normalizeExtensionStatus(payload)))
      .then((stop) => (closed ? stop() : (unlisten = stop)))
      .catch(() => undefined)
    // It may have become ready before the listener was up.
    extensionStatus(needs).then(settle, () => undefined)
    return () => {
      closed = true
      done = true
      unlisten?.()
    }
  }, [pending, commit])
  const prompt = asking ? extensionDownloadPrompt(asking.status) : null

  const handleApiUrlChange = useCallback(
    (value: string): void => {
      void setYomitanSettings({ ...yomitanSettings, customApiUrl: value })
      setApiTestStatus('idle')
    },
    [yomitanSettings, setYomitanSettings]
  )

  const handleTestApiConnection = useCallback(async (): Promise<void> => {
    setApiTestStatus('testing')
    try {
      const result = await testApiConnection(yomitanSettings.customApiUrl)
      setApiTestStatus(result.success ? 'success' : 'error')
      if (!result.success) console.error('API test failed:', result.error)
    } catch (error) {
      console.error('Failed to test API connection:', error)
      setApiTestStatus('error')
    }
  }, [yomitanSettings.customApiUrl])

  const restriction = yomitanSettings.customApiUrl
    ? describeUrlRestriction(yomitanSettings.customApiUrl)
    : null

  const renderSettings = (engine: DictionaryEngine, inUse: boolean): ReactNode => {
    if (engine !== 'custom-api') {
      const name = DICTIONARY_ENGINES[engine].name
      return (
        <div className="dictionary-engine-action">
          <div className="engine-setting-text">
            <span className="engine-setting-label">{name} settings</span>
            <span className="k-description">
              {inUse
                ? `Dictionaries, scanning and lookups are set up in ${name}'s own settings.`
                : `${name}'s own settings open here once it is the active engine.`}
            </span>
          </div>
          {inUse && (
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
      )
    }
    return (
      <>
        <SettingsSection grouped>
          <SettingsRow
            stacked
            label="Yomitan API URL"
            controlId="dictionary-api-url"
            description="The URL of your Yomitan API endpoint. Test verifies the connection."
          >
            <div className="settings-url">
              <span title={STATUS_LABEL[apiTestStatus]} className="settings-url-status">
                <StatusDot tone={STATUS_TONE[apiTestStatus]} />
              </span>
              <span className="sr-only" role="status">
                {STATUS_LABEL[apiTestStatus]}
              </span>
              <Input
                id="dictionary-api-url"
                mono
                value={yomitanSettings.customApiUrl}
                onChange={(e) => handleApiUrlChange(e.target.value)}
                placeholder={API_URLS.YOMITAN_FALLBACK}
              />
              <Button onClick={() => void handleTestApiConnection()} disabled={apiTestStatus === 'testing'}>
                {apiTestStatus === 'testing' ? 'Testing…' : 'Test'}
              </Button>
            </div>
          </SettingsRow>
          {restriction && (
            <div className="settings-note">
              <Callout tone="warn">{restriction}</Callout>
            </div>
          )}
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
            if (!open) setAsking(null)
          }}
          title={prompt?.title ?? ''}
          description={prompt?.description}
          confirmLabel="Download"
          onConfirm={confirmDownload}
          dismissOnOutsideClick
        />
        <DictionaryChooser
          active={active}
          pending={pending}
          onChoose={(engine) => void handleChoose(engine)}
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

/** Everything that only applies to Kimochi's own pop-up. */
function KimochiPopupSections({ settings }: { settings: Settings }): ReactNode {
  const volume = Math.round(settings.audioVolume * 100)
  return (
    <div className="texthooker dictionary-engine-sections">
      <SettingsSection title="In the Log">
        <SettingsRow
          label="Click a word to look it up"
          controlId="dictionary-click"
          description="Off makes the text selectable instead. Shift-hover still looks words up."
        >
          <Switch
            id="dictionary-click"
            checked={!settings.disableClickToDefine}
            onCheckedChange={(v) => void updateSettings({ disableClickToDefine: !v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Split lines into words on arrival"
          controlId="dictionary-tokenize"
          description="Otherwise a line is split the first time you point at it."
        >
          <Switch
            id="dictionary-tokenize"
            checked={settings.tokenizeOnArrival}
            onCheckedChange={(v) => void updateSettings({ tokenizeOnArrival: v })}
          />
        </SettingsRow>
        <SettingsRow label="Show furigana" controlId="dictionary-furigana">
          <Switch
            id="dictionary-furigana"
            checked={settings.showFurigana}
            onCheckedChange={(v) => void updateSettings({ showFurigana: v })}
          />
        </SettingsRow>
      </SettingsSection>

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

      <AnkiSetup settings={settings} />
    </div>
  )
}
