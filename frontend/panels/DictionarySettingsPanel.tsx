/**
 * The active dictionary engine's own settings page inside Kimochi's panel chrome (the
 * `dictionary` window; DICTIONARY_ENGINES.md §3 and §8).
 *
 * - Yomitan: the distributed `/settings.html`, unmodified, in a frame; the window's init script
 *   gives that frame the panel shim, which relays backend calls to the overlay's single backend.
 * - Hachidori, 10ten: the extension's options page from its own origin
 *   (`hachidori://localhost/settings.html`, `tenten://localhost/options.html`); the generic host
 *   injected into that frame relays its extension-page context to the overlay's hub.
 * - The Yomitan API (Kimochi's own pop-up) has no page of its own: a note and the way to
 *   Settings → Dictionary.
 *
 * The title follows the SETTING; the page waits until this document's host is that engine's.
 * Navigation requests (an extension opening another of its pages) arrive as the window event
 * `kimochi-dictionary-navigate`, or wait in `__kimochiExtensionHost.pendingNavigate` when they
 * came before React mounted; only URLs on the engine's own origin are followed. Settings → Anki
 * opens the page at its `#anki` section (`openDictionarySettingsSection`).
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Button, Callout, Spinner } from '@kit'
import { nativeError, openSettings } from '../bridge/tauri'
import {
  DICTIONARY_ENGINES,
  DICTIONARY_SECTION_EVENT,
  NO_ENGINE,
  documentEngine,
  extensionHost,
  extensionOrigin,
  isExtensionEngine,
  takeDictionarySection,
  useDictionaryEngine,
  type DictionaryEngine
} from '../bridge/dictionaryEngine'
import { frameDocument, revealSectionWhenLoaded } from './dictionarySection'
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
  if (engine === 'custom-api') return <YomitanApiNote />
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
  const frame = useRef<HTMLIFrameElement>(null)
  const [first] = useState(() => {
    const pending = acceptNavigation(engine, extensionHost()?.pendingNavigate)
    const section = takeDictionarySection()
    const options = optionsUrl(engine)
    return section && options
      ? { src: `${options}#${section}`, section }
      : { src: pending ?? options, section: null }
  })
  const [src, setSrc] = useState<string | null>(first.src)
  // Yomitan's section to scroll to once its page has loaded and laid itself out (see
  // dictionarySection.ts): its fragment alone is applied too early, and the page opens at the top.
  const yomitanSection = useRef<string | null>(engine === 'yomitan' ? first.section : null)
  const revealYomitanSection = (): void => {
    const section = yomitanSection.current
    if (!section) return
    yomitanSection.current = null
    void revealSectionWhenLoaded(() => frameDocument(frame.current), section)
  }

  // A section asked for while this page is open: the options page, scrolled to it. Assigning the
  // frame's location (allowed across origins) re-scrolls even when the fragment is already there.
  useEffect(() => {
    const options = optionsUrl(engine)
    if (!options) return
    const pending = listen<{ section?: unknown }>(DICTIONARY_SECTION_EVENT, (event) => {
      // The event carries the section; the stored copy was for a window still being built.
      takeDictionarySection()
      const section = event.payload?.section
      if (typeof section !== 'string' || !/^[\w-]+$/.test(section)) return
      const target = new URL(`${options}#${section}`, window.location.href).href
      const view = frame.current?.contentWindow
      const ready = Boolean(view && frame.current?.dataset.loaded)
      if (engine === 'yomitan') {
        // On its page already: scroll once it is laid out (at once when it is). Elsewhere (another
        // Yomitan page, or still loading): load the options page, and scroll when it has loaded.
        yomitanSection.current = section
        const doc = ready ? frameDocument(frame.current) : null
        if (doc && new URL(doc.URL).pathname === new URL(target).pathname) {
          doc.defaultView?.history.replaceState(null, '', target)
          revealYomitanSection()
          return
        }
        if (view && ready) view.location.href = target
        else setSrc(target)
        return
      }
      if (view && ready) view.location.href = target
      else setSrc(target)
    })
    return () => {
      void pending.then((off) => off())
    }
  }, [engine])

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
        ref={frame}
        title={`${name} settings`}
        src={src}
        className="dictionary-settings-frame"
        // An extension page is cross-origin here: without these, its copy buttons (Hachidori's
        // sharing address) and audio previews are refused by WebView2's permissions policy.
        allow="clipboard-read; clipboard-write; autoplay"
        data-loaded={loaded || undefined}
        onLoad={() => {
          setLoaded(true)
          revealYomitanSection()
        }}
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

function YomitanApiNote(): JSX.Element {
  return (
    <div className="dictionary-settings dictionary-settings-note">
      <p className="k-description">
        The Yomitan API uses the dictionaries in your browser&apos;s Yomitan, so there is nothing to
        manage here. Its connection, pop-up size and audio are in Settings → Dictionary, and its Anki
        cards in Settings → Anki.
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
