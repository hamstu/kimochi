/**
 * Settings → Anki, in three tabs across the top (no title: the tabs name the page):
 *
 *  - **AnkiConnect**: Kimochi's own connection, checked live (`anki_connect_status`, every few
 *    seconds while it shows, and on Check), with the address and the optional API key. Shown
 *    whatever the dictionary engine: the Yomitan API pop-up, the main window's Anki tab and
 *    sentence audio's field detection all use it. Its defaults are AnkiConnect's, so it usually
 *    works untouched.
 *  - **Mining**: how cards are added with the engine (`ANKI_ROUTE`). The Yomitan API pop-up is
 *    Kimochi's own, so its card builder (`AnkiSetup`) is here. Built-in Yomitan and Hachidori add
 *    cards from their pop-ups with their own Anki settings, AnkiConnect address and key included,
 *    which a button opens at `#anki`; Kimochi only sends their requests on from Rust, unchanged
 *    (COMMANDS.md "AnkiConnect"). 10ten adds none.
 *  - **Card enhancement**: sentence audio (`SentenceAudioSection`) and tags (`CardTagsSection`),
 *    for every engine.
 *
 * The tab is `ankiPageTab`'s, so links elsewhere in the main window can choose it (the sidebar's
 * Enhance Anki cards cog, the Anki tab's empty state).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Pickaxe, Plug, Sparkles } from 'lucide-react'
import {
  Button,
  Callout,
  Input,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsTabs,
  Spinner,
  StatusDot
} from '@kit'
import {
  ANKI_ROUTE,
  DEFAULT_ANKI_CONNECT_URL,
  describeAnkiStatus,
  isLocalAddress,
  nextCheckMs,
  normalizeAnkiConnectUrl,
  type AnkiConnectStatus
} from '@ui/anki-connect'
import { AnkiSetup } from '@texthooker/components/AnkiSetup'
import { checkAnkiConnect } from '@texthooker/lib/ankiconnect'
import { updateSettings } from '@texthooker/lib/settings'
import type { Settings } from '@texthooker/lib/types'
import { setSetting } from '../../bridge/settings'
import { nativeError } from '../../bridge/tauri'
import {
  DICTIONARY_ENGINES,
  openDictionarySettingsSection,
  useDictionaryEngine,
  type DictionaryEngine
} from '../../bridge/dictionaryEngine'
import { useDictionaryReadiness } from '../../bridge/dictionaryReadiness'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { SentenceAudioSection } from './SentenceAudioSection'
import { CardTagsSection } from './CardTagsSection'
import { useAnkiTab, type AnkiTabName } from './ankiPageTab'

const TABS = [
  { value: 'connect', label: 'AnkiConnect', icon: <Plug aria-hidden /> },
  { value: 'mining', label: 'Mining', icon: <Pickaxe aria-hidden /> },
  {
    value: 'enhance',
    label: 'Card enhancement',
    icon: <Sparkles aria-hidden />
  }
] as const satisfies readonly {
  value: AnkiTabName
  label: string
  icon: ReactNode
}[]

export function AnkiTab(): ReactNode {
  return <WithReaderSettings>{(settings) => <AnkiPage settings={settings} />}</WithReaderSettings>
}

function AnkiPage({ settings }: { settings: Settings }): ReactNode {
  const [engine] = useDictionaryEngine()
  const [tab, setTab] = useAnkiTab()
  const saved = settings.ankiConnectUrl || DEFAULT_ANKI_CONNECT_URL
  const connection = useAnkiConnection(saved, settings.ankiConnectKey)
  return (
    <div className="k-settings-tabbed">
      <SettingsTabs aria-label="Anki" value={tab} onValueChange={setTab} options={TABS} />
      <div className="k-settings-tabbed-scroll">
        <SettingsPage>
          {tab === 'connect' && (
            <ConnectionSection
              settings={settings}
              engine={engine}
              status={connection.status}
              checking={connection.checking}
              onCheck={connection.check}
            />
          )}
          {tab === 'mining' && (
            <AnkiSections settings={settings} engine={engine} connection={connection.epoch} />
          )}
          {tab === 'enhance' && (
            <>
              <SentenceAudioSection />
              <CardTagsSection />
            </>
          )}
        </SettingsPage>
      </div>
    </div>
  )
}

/**
 * The connection check for `url` and `key`: once when they change, then again after
 * `nextCheckMs`, while the window is visible. `epoch` counts the times it became connected.
 */
function useAnkiConnection(
  url: string,
  key: string
): {
  status: AnkiConnectStatus | null
  checking: boolean
  check: () => void
  epoch: number
} {
  const [status, setStatus] = useState<AnkiConnectStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [request, setRequest] = useState(0)
  const connected = useRef(false)

  useEffect(() => {
    let live = true
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async (): Promise<void> => {
      if (running) return
      running = true
      clearTimeout(timer)
      let next: AnkiConnectStatus
      try {
        next = await checkAnkiConnect(url, key)
      } catch (error) {
        next = { state: 'error', url, message: nativeError(error).message }
      }
      running = false
      if (!live) return
      const now = next.state === 'connected'
      if (now && !connected.current) setEpoch((n) => n + 1)
      connected.current = now
      setStatus(next)
      setChecking(false)
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') void run()
      }, nextCheckMs(next))
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void run()
    }
    void run()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [url, key, request])

  const check = useCallback(() => {
    setChecking(true)
    setRequest((n) => n + 1)
  }, [])
  return { status, checking, check, epoch }
}

function AnkiSections({
  settings,
  engine,
  connection
}: {
  settings: Settings
  engine: DictionaryEngine
  connection: number
}): ReactNode {
  const route = ANKI_ROUTE[engine]
  const runtime = useDictionaryReadiness(engine)
  const downloaded = runtime.download === null || runtime.download === 'ready'
  // Only Kimochi's own pop-up adds cards with Kimochi's connection; before an engine is
  // downloaded there are no cards to add yet, so only the way to download it.
  return (
    <CardsSection
      settings={settings}
      engine={engine}
      connection={route === 'kimochi' && downloaded ? connection : 0}
    />
  )
}

function ConnectionSection({
  settings,
  engine,
  status,
  checking,
  onCheck
}: {
  settings: Settings
  engine: DictionaryEngine
  status: AnkiConnectStatus | null
  checking: boolean
  onCheck: () => void
}): ReactNode {
  const saved = settings.ankiConnectUrl || DEFAULT_ANKI_CONNECT_URL
  const [urlDraft, setUrlDraft] = useState(saved)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState(settings.ankiConnectKey)
  // A change saved elsewhere (another window, Sync) replaces the field.
  const [seen, setSeen] = useState({
    url: saved,
    key: settings.ankiConnectKey
  })
  if (seen.url !== saved || seen.key !== settings.ankiConnectKey) {
    setSeen({ url: saved, key: settings.ankiConnectKey })
    setUrlDraft(saved)
    setKeyDraft(settings.ankiConnectKey)
    setUrlError(null)
  }

  const saveUrl = (value: string): void => {
    const address = normalizeAnkiConnectUrl(value)
    if (!address.ok) {
      setUrlError(address.error)
      return
    }
    setUrlError(null)
    setUrlDraft(address.url)
    if (address.url !== saved) void updateSettings({ ankiConnectUrl: address.url })
  }
  const saveKey = (value: string): void => {
    const key = value.trim()
    if (key !== settings.ankiConnectKey) void updateSettings({ ankiConnectKey: key })
  }

  const text = describeAnkiStatus(status)
  const suggestion =
    status && (status.state === 'notRunning' || status.state === 'notAnkiConnect')
      ? status.suggestion
      : null
  const name = DICTIONARY_ENGINES[engine].name

  return (
    <SettingsSection
      description="Kimochi's connection to Anki, through the AnkiConnect add-on. The Anki tab in the main window, sentence audio and the Yomitan API pop-up use it. The usual address works unless you changed AnkiConnect's."
      footnote={
        ANKI_ROUTE[engine] === 'engine'
          ? `${name} adds its cards with its own AnkiConnect address, set in its Anki settings under Mining.`
          : undefined
      }
    >
      <SettingsRow
        label={
          <span className="anki-connection-label">
            {status === null || checking ? (
              <Spinner label="Checking" />
            ) : (
              <StatusDot tone={text.tone} />
            )}
            {text.title}
          </span>
        }
        description={<span role="status">{text.detail}</span>}
      >
        {suggestion && (
          <Button size="sm" variant="primary" onClick={() => saveUrl(suggestion)}>
            Use {suggestion.replace(/^https?:\/\//, '')}
          </Button>
        )}
        <Button size="sm" onClick={onCheck} disabled={checking}>
          Check
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Address"
        controlId="anki-url"
        description={
          isLocalAddress(saved)
            ? 'The AnkiConnect address.'
            : "Another computer's AnkiConnect must listen on your network: set its webBindAddress, and allow its port through that computer's firewall."
        }
      >
        <Input
          id="anki-url"
          mono
          className="settings-field"
          value={urlDraft}
          aria-invalid={urlError ? true : undefined}
          onChange={(e) => {
            setUrlDraft(e.target.value)
            setUrlError(null)
          }}
          onBlur={(e) => saveUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveUrl(e.currentTarget.value)
          }}
          placeholder={DEFAULT_ANKI_CONNECT_URL}
        />
      </SettingsRow>
      {urlError && (
        <div className="settings-note">
          <Callout tone="danger">{urlError}</Callout>
        </div>
      )}
      <SettingsRow label="API key" controlId="anki-key" description="Optional AnkiConnect apiKey.">
        <Input
          id="anki-key"
          type="password"
          mono
          autoComplete="off"
          className="settings-field"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          onBlur={(e) => saveKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveKey(e.currentTarget.value)
          }}
          placeholder="None"
        />
      </SettingsRow>
    </SettingsSection>
  )
}

function CardsSection({
  settings,
  engine,
  connection
}: {
  settings: Settings
  engine: DictionaryEngine
  connection: number
}): ReactNode {
  const name = DICTIONARY_ENGINES[engine].name
  const route = ANKI_ROUTE[engine]
  const showDictionary = (): void => {
    setSetting('settingsActiveTab', 'dictionary').catch((error) =>
      console.error('Open Settings → Dictionary failed:', nativeError(error).message)
    )
  }

  if (route === 'kimochi') {
    return (
      <div className="texthooker anki-kimochi-sections">
        <AnkiSetup
          settings={settings}
          connection={connection}
          title={`Adding cards with the ${name}`}
          description="Kimochi's own pop-up adds the card. The Yomitan in your browser keeps its own Anki settings for the cards it adds there."
        />
      </div>
    )
  }

  if (route === 'none') {
    return (
      <SettingsSection title="Cards">
        <SettingsRow label={`${name} doesn't add Anki cards.`}>
          <Button size="sm" onClick={showDictionary}>
            Choose a dictionary
          </Button>
        </SettingsRow>
      </SettingsSection>
    )
  }

  return <EngineAnkiRow engine={engine} onChooseDictionary={showDictionary} />
}

/**
 * Built-in Yomitan and Hachidori keep their own Anki settings (deck, note type, fields, the
 * AnkiConnect address): a way to them once the engine's settings page can open. Before it is
 * downloaded there is nothing to set up, so only the way to download it; while it starts, a
 * disabled button says so.
 */
function EngineAnkiRow({
  engine,
  onChooseDictionary
}: {
  engine: DictionaryEngine
  onChooseDictionary: () => void
}): ReactNode {
  const name = DICTIONARY_ENGINES[engine].name
  const runtime = useDictionaryReadiness(engine)
  if (runtime.download !== null && runtime.download !== 'ready') {
    return (
      <SettingsSection title="Cards">
        <SettingsRow label="Download a dictionary to add Anki cards.">
          <Button size="sm" onClick={onChooseDictionary}>
            Go to Dictionary
          </Button>
        </SettingsRow>
      </SettingsSection>
    )
  }
  return (
    <SettingsSection title="Cards">
      <SettingsRow label={`${name} keeps its own Anki settings.`}>
        {runtime.view.settingsAvailable ? (
          <Button
            size="sm"
            onClick={() => {
              openDictionarySettingsSection('anki').catch((error) =>
                console.error(`Open ${name} Anki settings failed:`, nativeError(error).message)
              )
            }}
          >
            Open {name} Anki settings
          </Button>
        ) : (
          <Button size="sm" disabled>
            <Spinner label={`Starting ${name}`} />
            Starting {name}…
          </Button>
        )}
      </SettingsRow>
    </SettingsSection>
  )
}
