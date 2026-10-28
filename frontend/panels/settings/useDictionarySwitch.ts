/**
 * Switching the dictionary engine, shared by Settings → Dictionary and the main window sidebar's
 * dictionary picker (the two are never on screen together in the main window).
 *
 * Choosing an engine saves `yomitanSettings.popupType`, writes the document-start mirror and asks
 * native to reload the reader windows (`dictionary_engine_apply`); the main window is one of them,
 * so it first records where it is (`rememberEngineSwitch`, with `from` saying whether that is
 * Settings or the Log/Notebook the sidebar sits beside). An engine that is not downloaded is asked
 * about first and switched to once its download is ready (a PENDING switch). Choosing the Yomitan
 * API switches at once and checks that the API answers (`verifyingApi`), giving the browser's
 * helper `API_GRACE_MS` to wake; only if it still does not answer does its setup wizard open
 * (`setupOpen`). See DictionaryTab.tsx for the whole story.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { YomitanSettings } from '../../vendor/shared-types'
import { resolveYomitanApiUrl } from '@ui/yomitan-api-setup'
import { waitForDictionarySetup } from '@ui/dictionary-setup-switch'
import { useSetting } from '../../bridge/useSetting'
import { setSetting } from '../../bridge/settings'
import { nativeError, onEvent } from '../../bridge/tauri'
import {
  applyDictionaryEngine,
  dictionaryEngineOf,
  documentPlaceholder,
  hostEngineOf,
  mirrorDictionaryEngine,
  popupTypeOf,
  type DictionaryEngine
} from '../../bridge/dictionaryEngine'
import { extensionAction, extensionStatus, type ExtensionStatus } from '../../bridge/extensions'
import { downloadEngineFor, extensionDownloadPrompt, normalizeExtensionStatus } from '@ui/extension-download'
import { engineSwitchRecord, forgetEngineSwitch, rememberEngineSwitch } from '../../main/engineSwitch'
import { demoStops } from '../../bridge/demo'
import { apiCheck } from '../../bridge/yomitanApi'

/** How long "Reloading the reader windows…" stays up after native has answered. */
export const RELOAD_NOTE_MS = 2500
/** How long "Now using …" stays up after the reload a switch gave this window. */
export const SWITCHED_NOTE_MS = 6000
/** How long a switch to the Yomitan API waits for it to answer before opening its setup. */
export const API_GRACE_MS = 2500
/** How often it asks in that time. */
const API_RETRY_MS = 500

/**
 * The engine this window was just reloaded into by a switch made here, while that is news. The
 * record is read once per document, so a later visit to this page does not announce it again.
 */
function justSwitchedTo(): DictionaryEngine | null {
  const record = engineSwitchRecord()
  return record && Date.now() - record.at < SWITCHED_NOTE_MS + 4000 ? record.engine : null
}

export function useDictionarySwitch(from: 'settings' | 'sidebar') {
  // Until the setting loads, the engine this document was (re)loaded for, not the shipped
  // default: after a switch the chooser's first frame already shows the new engine as active.
  const [switchedTo, setSwitchedTo] = useState<DictionaryEngine | null>(justSwitchedTo)
  const [yomitanSettings, setYomitanSettings] = useSetting<YomitanSettings>('yomitanSettings', {
    popupType: popupTypeOf(engineSwitchRecord()?.engine ?? documentPlaceholder()),
    customApiUrl: ''
  })
  const apiUrl = resolveYomitanApiUrl(yomitanSettings.customApiUrl)
  // The address the Yomitan API check asks at each attempt (the setting may load mid-check).
  const apiUrlRef = useRef(apiUrl)
  useEffect(() => {
    apiUrlRef.current = apiUrl
  }, [apiUrl])
  // The Yomitan API's setup wizard: opened from its Helper row, and by choosing the Yomitan API
  // (here, or on the reload a switch from Hachidori or 10ten gives this window) when the API has
  // not answered within API_GRACE_MS. `verifyingApi` counts the checks started (0: none running).
  const [setupOpen, openSetup] = useState(false)
  const [verifyingApi, setVerifyingApi] = useState(switchedTo === 'custom-api' ? 1 : 0)
  // Opened or closed by hand: a check still running has nothing more to say.
  const setSetupOpen = useCallback((open: boolean): void => {
    setVerifyingApi(0)
    openSetup(open)
  }, [])
  const saved = dictionaryEngineOf(yomitanSettings.popupType)
  // The pick, shown as active from the click so the panel does not flash "Use <name>" while
  // the write goes out. Cleared once the setting agrees (or the write fails).
  const [picked, setPicked] = useState<DictionaryEngine | null>(null)
  const active = picked ?? saved
  // What this window does once native has the switch: 'self' when it is about to be reloaded
  // itself (the main window), 'others' when only the reader windows are.
  const [reloading, setReloading] = useState<'self' | 'others' | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [waitingForImport, setWaitingForImport] = useState(false)
  const switchRequest = useRef(0)
  useEffect(() => () => { switchRequest.current++ }, [])

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
      const request = ++switchRequest.current
      setPicked(engine)
      setWaitingForImport(false)
      setApplyError(null)
      setSwitchedTo(null)
      try {
        const host = (window as unknown as {
          __extensionHost?: { toBackend: (message: object) => Promise<{ stage: string } | null> }
        }).__extensionHost
        if (saved === 'yomitan' && engine !== saved && host) {
          await waitForDictionarySetup(
            () => request === switchRequest.current
              ? host.toBackend({ action: '__setupDictionaries', params: { command: 'active' } })
              : Promise.resolve(null),
            () => { if (request === switchRequest.current) setWaitingForImport(true) }
          )
        }
        if (request !== switchRequest.current) return
        setWaitingForImport(false)
        // Through the settings client directly, not the hook's setter: that one reverts quietly
        // on failure, and a failed save must not go on to mirror and reload the windows.
        await setSetting('yomitanSettings', { ...yomitanSettings, popupType: popupTypeOf(engine) })
      } catch (error) {
        if (request !== switchRequest.current) return
        setWaitingForImport(false)
        setPicked(null)
        setApplyError(`Could not save the dictionary engine: ${nativeError(error).message}`)
        return
      }
      mirrorDictionaryEngine(engine)
      // The Yomitan API needs the browser side set up: check it answers, and open the wizard if
      // not. If this window is reloaded by the switch, the reloaded one checks again (`switchedTo`).
      if (engine === 'custom-api') setVerifyingApi((n) => n + 1)
      // The same host (only ever the same engine, saved again) needs no reload.
      if (hostEngineOf(engine) === hostEngineOf(saved)) return
      // Before native reloads this window, so the reload comes back to this page.
      setReloading(rememberEngineSwitch(engine, from) ? 'self' : 'others')
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
    [yomitanSettings, saved, from]
  )

  // Choosing: an engine that can run is switched to at once; one that is not downloaded is asked
  // about (absent) or resumed (paused, failed) and switched to once ready.
  const ticket = useRef(0)
  const handleChoose = useCallback(
    async (engine: DictionaryEngine): Promise<void> => {
      if (engine !== saved && demoStops('Switching dictionaries')) return
      const mine = ++ticket.current
      setApplyError(null)
      // Another engine: a Yomitan API check still running is moot.
      if (engine !== 'custom-api') setVerifyingApi(0)
      let status: ExtensionStatus | null = null
      const needs = downloadEngineFor(engine)
      try {
        // The Yomitan API downloads nothing: it is switched to at once.
        if (needs) status = await extensionStatus(needs)
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
    if (!needs) return
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

  // The check after choosing the Yomitan API: asked every API_RETRY_MS until it answers (nothing
  // more is shown) or API_GRACE_MS has passed (the setup wizard opens). Dropped when another
  // engine is chosen, when the wizard is opened or closed by hand, and when the window goes.
  const onApi = active === 'custom-api'
  if (verifyingApi !== 0 && !onApi) setVerifyingApi(0)
  useEffect(() => {
    if (verifyingApi === 0 || !onApi) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = Date.now() + API_GRACE_MS
    const attempt = async (): Promise<void> => {
      const answered = await apiCheck(apiUrlRef.current).then(
        (status) => status.yomitan,
        () => false
      )
      if (cancelled) return
      if (answered) {
        setVerifyingApi(0)
      } else if (Date.now() >= deadline) {
        setVerifyingApi(0)
        openSetup(true)
      } else {
        timer = setTimeout(() => void attempt(), API_RETRY_MS)
      }
    }
    void attempt()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [verifyingApi, onApi])

  return {
    yomitanSettings,
    setYomitanSettings,
    apiUrl,
    saved,
    active,
    pending,
    asking,
    dismissAsking: () => setAsking(null),
    prompt,
    confirmDownload,
    choose: handleChoose,
    reloading,
    waitingForImport,
    applyError,
    switchedTo,
    /** True while a switch to the Yomitan API is checking that it answers. */
    verifyingApi: verifyingApi > 0,
    setupOpen,
    setSetupOpen
  }
}
