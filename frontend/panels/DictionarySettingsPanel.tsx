/**
 * The active dictionary engine's own settings page inside Kimochi's panel chrome (the
 * `dictionary` window; DICTIONARY_ENGINES.md §3 and §8).
 *
 * - Yomitan: the distributed `/settings.html`, unmodified, in a frame; the window's init script
 *   gives that frame the panel shim, which relays backend calls to the overlay's single backend.
 * - Hachidori, 10ten: the extension's options page from its own origin
 *   (`hachidori://localhost/settings.html`, `tenten://localhost/options.html`); the generic host
 *   injected into that frame relays its extension-page context to the overlay's hub.
 * - Kimochi's pop-up has no page of its own: a note and the way to Settings → Dictionary.
 *
 * The title follows the SETTING; the page waits until this document's host is that engine's.
 * Navigation requests (an extension opening another of its pages) arrive as the window event
 * `kimochi-dictionary-navigate`, or wait in `__kimochiExtensionHost.pendingNavigate` when they
 * came before React mounted; only URLs on the engine's own origin are followed.
 */
import { useEffect, useState, type JSX } from 'react'
import { Button, Callout, Spinner } from '@kit'
import { nativeError, openSettings } from '../bridge/tauri'
import {
  DICTIONARY_ENGINES,
  NO_ENGINE,
  documentEngine,
  extensionHost,
  extensionOrigin,
  isExtensionEngine,
  useDictionaryEngine,
  type DictionaryEngine
} from '../bridge/dictionaryEngine'
import './dictionary-settings.css'

/** The engine's options page, or null when its origin is unknown here (outside Kimochi). */
function optionsUrl(engine: DictionaryEngine): string | null {
  if (engine === 'yomitan') return '/settings.html'
  if (!isExtensionEngine(engine)) return null
  const origin = extensionOrigin(engine)
  return origin ? `${origin}/${DICTIONARY_ENGINES[engine].optionsPage}` : null
}

/** The origin a navigation request must stay on: the engine's own, or the app's for Yomitan. */
function allowedOrigin(engine: DictionaryEngine): string | null {
  if (engine === 'yomitan') return window.location.origin
  return isExtensionEngine(engine) ? extensionOrigin(engine) : null
}

/** `url` when it is on the engine's origin, else null (and logged, so a refusal is visible). */
function acceptNavigation(engine: DictionaryEngine, url: unknown): string | null {
  const origin = allowedOrigin(engine)
  if (typeof url !== 'string' || !origin) return null
  try {
    const next = new URL(url, window.location.href)
    // Custom schemes (`tenten://localhost`) give an opaque `origin` ("null") in some engines, so
    // compare protocol and host as well as the origin string.
    const expected = new URL(`${origin}/`)
    if (next.protocol === expected.protocol && next.host === expected.host) return next.href
  } catch {
    // Not a URL: refused below.
  }
  console.warn(`[dictionary] refused to navigate the ${engine} settings to`, url)
  return null
}

export default function DictionarySettingsPanel(): JSX.Element {
  const [engine] = useDictionaryEngine()
  if (engine === 'custom-api') return <KimochiPopupNote />
  // The engine is chosen but not downloaded (or not yet): nothing can show its settings.
  if (documentEngine() === NO_ENGINE) return <NotDownloadedNote engine={engine} />
  // The page needs this document's host to be the engine's: after a switch the setting arrives
  // first, and native reloads this window a moment later. Loading the new engine's page under the
  // old host would hand it a `chrome.*` that answers for the wrong extension.
  if (engine !== documentEngine()) {
    const name = DICTIONARY_ENGINES[engine].name
    return (
      <div className="dictionary-settings">
        <div className="dictionary-settings-loading">
          <Spinner label={`Switching to ${name}`} />
          <span>Switching to {name}…</span>
        </div>
      </div>
    )
  }
  // Keyed by engine: a switch starts the page (and its loading state) over.
  return <EnginePage key={engine} engine={engine} />
}

function EnginePage({ engine }: { engine: Exclude<DictionaryEngine, 'custom-api'> }): JSX.Element {
  const name = DICTIONARY_ENGINES[engine].name
  const [loaded, setLoaded] = useState(false)
  const [src, setSrc] = useState<string | null>(() => {
    const pending = acceptNavigation(engine, extensionHost()?.pendingNavigate)
    return pending ?? optionsUrl(engine)
  })

  useEffect(() => {
    const onNavigate = (event: Event): void => {
      const next = acceptNavigation(engine, (event as CustomEvent<{ url?: string }>).detail?.url)
      if (!next) return
      setLoaded(false)
      setSrc(next)
    }
    window.addEventListener('kimochi-dictionary-navigate', onNavigate)
    // The first render took any request that was waiting; it must not be replayed on a remount.
    // A request that arrived between that render and this effect was dispatched before the
    // listener existed, so it is read once more here before being cleared.
    const host = extensionHost()
    if (host) {
      const late = acceptNavigation(engine, host.pendingNavigate)
      host.pendingNavigate = null
      // Replayed through the listener just added, so the effect itself sets no state.
      if (late) window.dispatchEvent(new CustomEvent('kimochi-dictionary-navigate', { detail: { url: late } }))
    }
    return () => window.removeEventListener('kimochi-dictionary-navigate', onNavigate)
  }, [engine])

  if (!src) {
    return (
      <div className="dictionary-settings dictionary-settings-note">
        <Callout tone="warn">
          {name}&apos;s settings page cannot be shown here: this window does not know where {name}{' '}
          is served from. Restart Kimochi; if it persists, report it from Diagnostics.
        </Callout>
      </div>
    )
  }

  return (
    <div className="dictionary-settings">
      {!loaded && (
        <div className="dictionary-settings-loading">
          <Spinner label={`Loading ${name} settings`} />
          <span>Loading {name} settings…</span>
        </div>
      )}
      <iframe
        title={`${name} settings`}
        src={src}
        className="dictionary-settings-frame"
        data-loaded={loaded || undefined}
        onLoad={() => setLoaded(true)}
      />
    </div>
  )
}

function NotDownloadedNote({ engine }: { engine: Exclude<DictionaryEngine, 'custom-api'> }): JSX.Element {
  const name = DICTIONARY_ENGINES[engine].name
  return (
    <div className="dictionary-settings dictionary-settings-note">
      <p className="k-description">
        {name} is not downloaded yet, so there are no settings to show and words are not looked up.
        Download it, or choose another dictionary, in Settings → Dictionary.
      </p>
      <div>
        <Button
          size="sm"
          onClick={() => {
            openSettings('dictionary').catch((error) =>
              console.error('Open Settings failed:', nativeError(error).message)
            )
          }}
        >
          Open Settings → Dictionary
        </Button>
      </div>
    </div>
  )
}

function KimochiPopupNote(): JSX.Element {
  return (
    <div className="dictionary-settings dictionary-settings-note">
      <p className="k-description">
        The Kimochi pop-up has no settings page of its own: its server, pop-up size, audio and Anki
        cards are all in Settings → Dictionary.
      </p>
      <div>
        <Button
          size="sm"
          onClick={() => {
            openSettings('dictionary').catch((error) =>
              console.error('Open Settings failed:', nativeError(error).message)
            )
          }}
        >
          Open Settings → Dictionary
        </Button>
      </div>
    </div>
  )
}
