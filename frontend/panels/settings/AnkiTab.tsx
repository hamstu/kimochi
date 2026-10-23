/**
 * Settings → Anki: shown whatever the dictionary engine. Two parts:
 *
 *  - AnkiConnect, for every route: the connection, checked live (`anki_connect_status`, every few
 *    seconds while this page is open, and on Check), the address and the optional API key. Every
 *    AnkiConnect request Kimochi makes, its own and the dictionary extension's, goes to this
 *    address from Rust (COMMANDS.md "AnkiConnect"); the address in an extension's own settings is
 *    not used.
 *  - How cards are added with the engine in use (`ANKI_ROUTE`): the Yomitan API pop-up is
 *    Kimochi's own, so its card builder (`AnkiSetup`) is here; Built-in Yomitan and Hachidori add
 *    cards from their pop-ups with their own Anki settings, which a button opens at `#anki`; 10ten
 *    adds none.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Callout,
  Input,
  SettingsPage,
  SettingsRow,
  SettingsSection,
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
import { WithReaderSettings } from './ReaderSettingsProvider'

export function AnkiTab(): ReactNode {
  const [engine] = useDictionaryEngine()
  return (
    <SettingsPage
      title="Anki"
      description="Words you look up, added to Anki as cards through the AnkiConnect add-on."
    >
      <WithReaderSettings>
        {(settings) => <AnkiSections settings={settings} engine={engine} />}
      </WithReaderSettings>
    </SettingsPage>
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
  engine
}: {
  settings: Settings
  engine: DictionaryEngine
}): ReactNode {
  const saved = settings.ankiConnectUrl || DEFAULT_ANKI_CONNECT_URL
  const { status, checking, check, epoch } = useAnkiConnection(saved, settings.ankiConnectKey)
  return (
    <>
      <ConnectionSection
        settings={settings}
        engine={engine}
        status={status}
        checking={checking}
        onCheck={check}
      />
      <CardsSection settings={settings} engine={engine} connection={epoch} />
    </>
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
  const route = ANKI_ROUTE[engine]

  return (
    <SettingsSection
      title="AnkiConnect"
      description={
        route === 'engine'
          ? `Kimochi sends every AnkiConnect request here, its own and ${name}'s.`
          : 'Kimochi sends every AnkiConnect request here.'
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
            ? `Where AnkiConnect listens: ${DEFAULT_ANKI_CONNECT_URL} unless its webBindPort is changed. A port number on its own is enough.`
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
      <SettingsRow
        label="API key"
        controlId="anki-key"
        description="Only if AnkiConnect's config sets an apiKey. Kept on this computer, never synced."
      >
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
      <SettingsSection title={`Adding cards with ${name}`}>
        <SettingsRow
          label={`${name} does not add Anki cards`}
          description="To add cards, choose Built-in Yomitan, Hachidori or the Yomitan API as your dictionary."
        >
          <Button size="sm" onClick={showDictionary}>
            Choose a dictionary
          </Button>
        </SettingsRow>
      </SettingsSection>
    )
  }

  const how =
    engine === 'yomitan'
      ? `${name} adds the card from its pop-up once Enable Anki integration is on in its Anki settings, which also hold the deck, note type and fields.`
      : `${name} adds the card from its pop-up, using the Templates in its Anki settings for the deck, note type and fields.`
  return (
    <SettingsSection title={`Adding cards with ${name}`}>
      <SettingsRow
        label={`${name}'s Anki settings`}
        description={`${how} The AnkiConnect address there is not used: Kimochi sends ${name}'s requests to the address above, with the API key above when one is set.`}
      >
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
      </SettingsRow>
    </SettingsSection>
  )
}
