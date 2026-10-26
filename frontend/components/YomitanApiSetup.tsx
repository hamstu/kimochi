/**
 * The Yomitan API setup: one set of components for onboarding's dictionary step and the Settings
 * → Dictionary dialog.
 *
 *   1. Install the helper. Detects what is registered: nothing → one-click install of Kimochi's
 *      helper (the Go host), with the official instructions as the alternative; the official
 *      helper (or another one) → used as it is, with replacing it as a secondary action.
 *   2. Turn on the API in the browser's Yomitan settings.
 *   3. Connect: the API is asked every second while the wizard is open; installed but silent
 *      means the browser is closed, the setting is off, or the browser suspended the helper.
 *      Green plays a short sound once and finishes.
 *
 * The step's buttons go through `Actions`, so the onboarding bar (`StepActions`) and a dialog's
 * footer (`DialogActionsSlot`) can each hold them. Nothing here blocks: every step can be skipped.
 */
import { createContext, useContext, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { Button, Callout, Dialog, DialogContent, SettingsRow, Spinner, StatusDot } from '@kit'
import {
  CONNECTION_TONE,
  METHOD_LABEL,
  OFFICIAL_HOST_URL,
  SETUP_STEPS,
  STEP_LABEL,
  brokenBrowsers,
  connectionState,
  describeConnection,
  describeHost,
  initialStep,
  listNames,
  stepDone,
  type ApiStatus,
  type HostStatus,
  type SetupStep
} from '@ui/yomitan-api-setup'
import { playAudio, soundKindOn } from '@ui/sounds'
import { getSetting } from '../bridge/settings'
import { nativeError } from '../bridge/tauri'
import { installHost, useYomitanApiSetup } from '../bridge/yomitanApi'
import './yomitan-api-setup.css'

type ActionsComponent = (props: { children: ReactNode }) => ReactNode

const open = (url: string): void => {
  openUrl(url).catch((error: unknown) => console.error('Open link failed:', nativeError(error).message))
}

/** The interface's click, unless sound effects (or their clicks) are off. */
function playSuccess(): void {
  Promise.all([
    getSetting<boolean>('soundEffects', true),
    getSetting<boolean>('soundEffectsClicks', true),
    getSetting<unknown>('sentenceAudio', null)
  ])
    .then(([soundEffects, soundEffectsClicks, sentenceAudio]) => {
      if (soundKindOn({ soundEffects, soundEffectsClicks, sentenceAudio }, 'clicks')) playAudio('click')
    })
    .catch(() => playAudio('click'))
}

type Install = { state: 'idle' | 'installing' | 'done' | 'error'; message: string | null }

// ---------------------------------------------------------------- pieces

function ConnectionLine({ host, api }: { host: HostStatus | null; api: ApiStatus | null }): JSX.Element {
  const state = connectionState(host, api)
  return (
    <p className="yomitan-setup-status" role="status">
      {state === 'checking' ? <Spinner label="Checking" /> : <StatusDot tone={CONNECTION_TONE[state]} />}
      {describeConnection(state, api)}
    </p>
  )
}

/** Where each browser's registration points, for the curious and for bug reports. */
function Registrations({ host }: { host: HostStatus }): JSX.Element | null {
  if (host.browsers.length === 0) return null
  return (
    <details className="yomitan-setup-details">
      <summary>Where it is registered</summary>
      <ul>
        {host.browsers.map((b) => (
          <li key={`${b.browser}-${b.manifestPath}`}>
            <span className="k-medium">{b.browserName}</span>
            {' · '}
            {b.method ? METHOD_LABEL[b.method] : 'Unreadable'}
            {b.problem && <span className="yomitan-setup-problem"> · {b.problem}</span>}
            <span className="k-mono yomitan-setup-path">{b.hostPath ?? b.manifestPath}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function Steps({
  step,
  host,
  api,
  onStep
}: {
  step: SetupStep
  host: HostStatus | null
  api: ApiStatus | null
  onStep: (step: SetupStep) => void
}): JSX.Element {
  return (
    <ol className="yomitan-setup-steps" aria-label="Setup steps">
      {SETUP_STEPS.map((s, i) => {
        const done = stepDone(s, host, api)
        return (
          <li key={s}>
            <button
              type="button"
              className="yomitan-setup-step"
              data-current={s === step || undefined}
              data-done={done || undefined}
              aria-current={s === step ? 'step' : undefined}
              onClick={() => onStep(s)}
            >
              <span className="yomitan-setup-step-mark" aria-hidden>
                {done ? <Check /> : i + 1}
              </span>
              {STEP_LABEL[s]}
              {done && <span className="sr-only"> (done)</span>}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function HelperStep({
  host,
  install,
  onInstall
}: {
  host: HostStatus | null
  install: Install
  onInstall: () => void
}): JSX.Element {
  if (!host) {
    return (
      <p className="yomitan-setup-status" role="status">
        <Spinner label="Checking" />
        Looking for a Yomitan API helper on this computer…
      </p>
    )
  }
  const broken = brokenBrowsers(host)
  return (
    <div className="yomitan-setup-body">
      {!host.installed ? (
        <>
          <p className="yomitan-setup-text">
            Press <strong>Install helper</strong> to add the small program your browser&apos;s
            Yomitan uses to talk to Kimochi.
          </p>
          {broken.length > 0 && (
            <Callout tone="warn">
              A helper is registered for {listNames(broken.map((b) => b.browserName))}, but it cannot
              start ({broken[0].problem ?? 'its program is missing'}). Installing replaces it.
            </Callout>
          )}
        </>
      ) : (
        <>
          <p className="yomitan-setup-status">
            <StatusDot tone="ok" />
            {describeHost(host)}
          </p>
          <p className="yomitan-setup-text">
            {host.method === 'kimochi'
              ? 'Nothing more to install.'
              : 'Kimochi uses it as it is: there is nothing to replace.'}
          </p>
          {host.method === 'kimochi' && (
            <p className="yomitan-setup-aside">
              Reinstalling fetches its latest version; restart your browser afterwards so it runs.{' '}
              <button type="button" className="k-link" disabled={install.state === 'installing'} onClick={onInstall}>
                Reinstall
              </button>
            </p>
          )}
          {host.method !== 'kimochi' && (
            <p className="yomitan-setup-aside">
              Kimochi&apos;s helper is a single program with no Python to keep installed. Installing
              it replaces this helper&apos;s registration in every browser.{' '}
              <button type="button" className="k-link" disabled={install.state === 'installing'} onClick={onInstall}>
                Use Kimochi&apos;s helper instead
              </button>
            </p>
          )}
        </>
      )}
      {install.state === 'installing' && (
        <p className="yomitan-setup-status" role="status">
          <Spinner label="Installing" />
          Downloading and installing the helper…
        </p>
      )}
      {install.state === 'done' && <Callout tone="ok">Installed. Next, turn on the API in Yomitan.</Callout>}
      {install.state === 'error' && (
        <Callout tone="danger">
          <span className="k-medium">The helper could not be installed.</span>
          {install.message && <pre className="yomitan-setup-pre">{install.message}</pre>}
          <span>
            Try again, or{' '}
            <button type="button" className="k-link" onClick={() => open(OFFICIAL_HOST_URL)}>
              install the official helper by hand
            </button>
            .
          </span>
        </Callout>
      )}
      <Registrations host={host} />
    </div>
  )
}

function EnableStep({ host, api }: { host: HostStatus | null; api: ApiStatus | null }): JSX.Element {
  return (
    <div className="yomitan-setup-body">
      <p className="yomitan-setup-text">In the browser where you use Yomitan:</p>
      <ol className="yomitan-setup-list">
        <li>Open Yomitan&apos;s settings (the Yomitan button in the toolbar, then the cog).</li>
        <li>
          Turn on <strong>Advanced</strong>, the switch at the bottom left.
        </li>
        <li>
          Under <strong>General</strong>, turn on <strong>Enable Yomitan API</strong>, and allow the
          permission your browser asks for.
        </li>
      </ol>
      <p className="yomitan-setup-aside">
        Already on? Quit and reopen your browser, so it starts the helper (a newly installed one is
        only found after a restart).
      </p>
      <ConnectionLine host={host} api={api} />
    </div>
  )
}

function ConnectStep({ url, host, api }: { url: string; host: HostStatus | null; api: ApiStatus | null }): JSX.Element {
  const state = connectionState(host, api)
  return (
    <div className="yomitan-setup-body">
      <ConnectionLine host={host} api={api} />
      {state === 'ready' ? (
        <p className="yomitan-setup-text">
          Kimochi looks words up through the Yomitan in your browser, with the dictionaries and
          settings you already have there.
        </p>
      ) : state === 'yomitan-silent' ? (
        <ul className="yomitan-setup-list">
          <li>Yomitan may still be starting: give it a few seconds.</li>
          <li>If it stays like this, open Yomitan&apos;s settings once, or restart the browser.</li>
        </ul>
      ) : (
        <ul className="yomitan-setup-list">
          <li>Open your browser. It starts the helper; Kimochi cannot.</li>
          <li>
            After installing the helper, quit the browser completely and open it again (closing the
            window is not always enough).
          </li>
          <li>
            Check that <strong>Enable Yomitan API</strong> is on in Yomitan&apos;s settings
            (Advanced, then General).
          </li>
          <li>Some browsers put idle extensions to sleep: open any page and this connects again.</li>
        </ul>
      )}
      <p className="yomitan-setup-aside">
        Checking <span className="k-mono">{url}</span> every second.
        {api?.error && state !== 'ready' && <> Last answer: {api.error}</>}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- the wizard

export function YomitanApiWizard({
  url,
  Actions,
  onFinish,
  finishLabel = 'Done',
  onSkip,
  skipLabel = 'Skip for now'
}: {
  /** The API address (`resolveYomitanApiUrl` of the setting). */
  url: string
  Actions: ActionsComponent
  onFinish: () => void
  finishLabel?: string
  onSkip: () => void
  skipLabel?: string
}): JSX.Element {
  const { host, api, refresh } = useYomitanApiSetup(url)
  const [step, setStep] = useState<SetupStep | null>(null)
  const [install, setInstall] = useState<Install>({ state: 'idle', message: null })
  const [celebrated, setCelebrated] = useState(false)
  const sawSilence = useRef(false)

  // Open on the first step with something to do, once both answers are in.
  if (step === null && host && api) setStep(initialStep(host, api))

  const ready = api?.yomitan === true
  useEffect(() => {
    if (!api) return
    if (!api.yomitan) {
      sawSilence.current = true
      return
    }
    // Green: once, and only after the wizard saw it not green (no chime for an existing setup).
    if (sawSilence.current && !celebrated) {
      setCelebrated(true)
      setStep('connect')
      playSuccess()
    }
  }, [api, celebrated])

  const runInstall = (): void => {
    setInstall({ state: 'installing', message: null })
    installHost()
      .then((output) => {
        setInstall({ state: 'done', message: output.trim() || null })
        // On to the browser side; the helper step still says what was installed.
        setStep((current) => (current === 'helper' ? 'enable' : current))
        return refresh()
      })
      .catch((error: unknown) => setInstall({ state: 'error', message: nativeError(error).message }))
  }

  const current = step ?? 'helper'
  const next = SETUP_STEPS[SETUP_STEPS.indexOf(current) + 1]
  const skip = (
    <Button variant="ghost" onClick={onSkip}>
      {skipLabel}
    </Button>
  )

  let actions: ReactNode
  if (ready && current === 'connect') {
    actions = (
      <Button variant="primary" onClick={onFinish}>
        {finishLabel}
      </Button>
    )
  } else if (current === 'helper' && host && !host.installed && !api?.server) {
    actions = (
      <>
        {skip}
        <Button variant="primary" disabled={install.state === 'installing'} onClick={runInstall}>
          {install.state === 'installing' ? 'Installing…' : install.state === 'error' ? 'Try again' : 'Install helper'}
        </Button>
      </>
    )
  } else if (current === 'connect') {
    actions = (
      <>
        {skip}
        <Button onClick={() => void refresh()}>Check again</Button>
      </>
    )
  } else {
    actions = (
      <>
        {skip}
        <Button variant="primary" disabled={!step} onClick={() => next && setStep(next)}>
          Next
        </Button>
      </>
    )
  }

  return (
    <div className="yomitan-setup">
      <Steps step={current} host={host} api={api} onStep={setStep} />
      {current === 'helper' && <HelperStep host={host} install={install} onInstall={runInstall} />}
      {current === 'enable' && <EnableStep host={host} api={api} />}
      {current === 'connect' && <ConnectStep url={url} host={host} api={api} />}
      <Actions>{actions}</Actions>
    </div>
  )
}

// ---------------------------------------------------------------- Settings

const DialogActionsSlot = createContext<HTMLElement | null>(null)

function DialogActions({ children }: { children: ReactNode }): ReactNode {
  const slot = useContext(DialogActionsSlot)
  return slot ? createPortal(children, slot) : null
}

/** The wizard in a modal, for Settings → Dictionary. */
export function YomitanApiSetupDialog({
  open: isOpen,
  onOpenChange,
  url
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  url: string
}): JSX.Element {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const close = (): void => onOpenChange(false)
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        title="Set up the Yomitan API"
        description="Look words up through the Yomitan already in your browser."
        footer={<div ref={setSlot} className="yomitan-setup-footer" />}
      >
        <DialogActionsSlot.Provider value={slot}>
          {isOpen && (
            <YomitanApiWizard url={url} Actions={DialogActions} onFinish={close} onSkip={close} skipLabel="Close" />
          )}
        </DialogActionsSlot.Provider>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Settings → Dictionary's two lines about the Yomitan API: is the helper installed, does the API
 * answer. Asked every few seconds while shown (the wizard, when open, asks every second itself).
 */
export function YomitanApiStatusRows({
  url,
  active,
  onSetUp
}: {
  url: string
  /** False while the setup dialog is open, which asks for itself. */
  active: boolean
  onSetUp: () => void
}): JSX.Element {
  const { host, api, refresh } = useYomitanApiSetup(url, { active, apiEveryMs: 5000, hostEveryMs: 10000 })
  const state = connectionState(host, api)
  return (
    <>
      <SettingsRow label="Helper" description={describeHost(host)}>
        <Button size="sm" variant={state === 'ready' ? 'secondary' : 'primary'} onClick={onSetUp}>
          {state === 'ready' ? 'Open setup' : 'Set up…'}
        </Button>
      </SettingsRow>
      <SettingsRow
        label={
          <span className="yomitan-setup-row-label">
            {state === 'checking' ? <Spinner label="Checking" /> : <StatusDot tone={CONNECTION_TONE[state]} />}
            Connection
          </span>
        }
        description={describeConnection(state, api)}
      >
        <Button size="sm" onClick={() => void refresh()}>
          Check
        </Button>
      </SettingsRow>
    </>
  )
}
