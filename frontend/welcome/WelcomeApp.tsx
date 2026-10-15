/**
 * The onboarding window: Kimochi's own panel chrome (the same title bar as the main window), one
 * step at a time above a persistent action bar.
 *
 *   intro → capture (Screen Recording permission, or the system picker) → Accessibility (macOS)
 *   → OCR engine → dictionary engine (choose + download) → that engine's setup → done
 *
 * Steps are hash routes, so a reload (switching dictionary engine reloads every reader window,
 * this one included) lands back on the same step. The bar holds Back on the left with the step
 * dots, and the step's own actions on the right (`StepActions`).
 */
import { useEffect, useState, type JSX } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { ChevronLeft, ExternalLink } from 'lucide-react'
import { Button, Callout, StatusDot } from '@kit'
import {
  accessibilityStatus,
  onEvent,
  openScreenCapturePreferences,
  requestAccessibility,
  useSystemPick
} from '../bridge/tauri'
import type { PanelStateEvent } from '../bridge/types'
import { useCapabilities } from '../bridge/capabilities'
import { useExtensionStatus } from '../bridge/extensions'
import { useDictionaryEngine } from '../bridge/dictionaryEngine'
import DictionarySettingsPanel from '../panels/DictionarySettingsPanel'
import { EngineChooser } from '../panels/settings/EngineChooser'
import { SystemPickerButton } from '../main/SourceGrid'
import macOSScreenPerms from './assets/howto-screen-macos.png'
import DictionarySetup, { DictionaryPractice } from './DictionarySetup'
import EngineSetup from './EngineSetup'
import IntroStep from './IntroStep'
import KimochiLogo from '../components/KimochiLogo'
import Step from './Step'
import { StepActions } from './StepActions'
import { StepActionsSlot } from './stepActionsSlot'
import { useCaptureStep, useHasScreenRecordingPermission } from './useHasScreenRecordingPermission'
import { completeOnboarding } from './welcome-actions'
import style from './WelcomeApp.module.css'

type StepId = 'intro' | 'capture' | 'accessibility' | 'ocr' | 'engine' | 'dictionaries' | 'done'

const STEP_OF: Record<string, StepId> = {
  '/': 'intro',
  '/screen-recording-permission': 'capture',
  '/system-picker': 'capture',
  '/accessibility': 'accessibility',
  '/ocr': 'ocr',
  '/engine': 'engine',
  '/dictionaries': 'dictionaries',
  '/dictionary-settings': 'dictionaries',
  '/done': 'done',
  '/main': 'done'
}

/**
 * Whether the dictionary the setting names can be used: its download (the Yomitan API needs
 * Built-in Yomitan's) is ready. Null until native answers (and on a backend without engine downloads).
 */
function useDictionaryReady(): boolean | null {
  const [engine] = useDictionaryEngine()
  const status = useExtensionStatus(engine === 'custom-api' ? 'yomitan' : engine)
  return status ? status.state === 'ready' : null
}

/**
 * Accessibility, where the platform has it (macOS): `granted`, `needed`, or `none` (no such
 * permission here, or not known yet). Polled while `watch`, so the step updates once the reader
 * turns Kimochi on in System Settings.
 */
function useAccessibility(watch: boolean): 'granted' | 'needed' | 'none' {
  const [status, setStatus] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    const check = (): void => {
      void accessibilityStatus()
        .then((next) => alive && setStatus(next))
        .catch(() => alive && setStatus(null))
    }
    check()
    const timer = watch ? setInterval(check, 2000) : undefined
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [watch])
  return status === null ? 'none' : status ? 'granted' : 'needed'
}

/** The flow for this computer: the capture and Accessibility steps only where something needs doing. */
function useFlow(pathname: string): {
  steps: StepId[]
  captureRoute: string | null
  accessibilityRoute: string | null
  back: string | null
} {
  const captureStep = useCaptureStep()
  const accessibility = useAccessibility(pathname === '/accessibility')
  const gaming = useCapabilities().session?.compositor?.toLowerCase() === 'gamescope'
  const dictionaryReady = useDictionaryReady()
  const captureRoute = gaming
    ? null
    : captureStep === 'permission'
      ? '/screen-recording-permission'
      : captureStep === 'picker'
        ? '/system-picker'
        : null
  const current = STEP_OF[pathname]
  const accessibilityRoute = !gaming && accessibility === 'needed' ? '/accessibility' : null
  const steps: StepId[] = [
    'intro',
    ...(captureRoute || current === 'capture' ? (['capture'] as const) : []),
    ...(accessibilityRoute || current === 'accessibility' ? (['accessibility'] as const) : []),
    'ocr',
    'engine',
    'dictionaries',
    'done'
  ]
  const BACK: Record<string, string> = {
    '/screen-recording-permission': '/',
    '/system-picker': '/',
    '/accessibility': captureRoute ?? '/',
    '/ocr': accessibilityRoute ?? captureRoute ?? '/',
    '/engine': '/ocr',
    '/dictionaries': '/engine',
    '/dictionary-settings': '/dictionaries',
    // A skipped engine has no setup step to go back to.
    '/done': dictionaryReady === false ? '/engine' : '/dictionaries',
    '/main': '/done'
  }
  return { steps, captureRoute, accessibilityRoute, back: BACK[pathname] ?? null }
}

// ---------------------------------------------------------------- capture

function ScreenPermissionScreen({ next }: { next: string }): JSX.Element {
  const hasPermission = useHasScreenRecordingPermission()
  const { restartAfterGrant } = useCapabilities().capture
  return (
    <Step
      title="Allow screen recording"
      lede={
        <>
          Kimochi reads Japanese by capturing the window you choose. Turn Kimochi on in System
          Settings → Privacy &amp; Security → Screen &amp; System Audio Recording.
          {restartAfterGrant && ' macOS may ask you to reopen Kimochi afterwards.'}
        </>
      }
    >
      <img
        className={style.screenshot}
        src={macOSScreenPerms}
        alt="System Settings, Screen & System Audio Recording, with the switch beside Kimochi"
        width={828}
        height={582}
      />
      <p className={style.status} role="status">
        <StatusDot tone={hasPermission ? 'ok' : 'warn'} />
        {hasPermission ? 'Screen recording is allowed.' : 'Not allowed yet. This updates on its own.'}
      </p>
      <StepActions>
        {hasPermission ? (
          <Button variant="primary" asChild>
            <Link to={next}>Continue</Link>
          </Button>
        ) : (
          <>
            <Button variant="ghost" asChild>
              <Link to={next}>Skip for now</Link>
            </Button>
            <Button variant="primary" onClick={() => void openScreenCapturePreferences()}>
              Open System Settings
              <ExternalLink />
            </Button>
          </>
        )}
      </StepActions>
    </Step>
  )
}

/**
 * Accessibility (macOS): what lets a click on the source bring that exact window forward,
 * including a game in full screen on a Space of its own. Optional; without it Kimochi brings
 * the application forward instead.
 */
function AccessibilityScreen(): JSX.Element {
  const granted = useAccessibility(true) === 'granted'
  return (
    <Step
      title="Allow Accessibility"
      lede={
        <>
          With Accessibility, clicking your source in Kimochi brings that exact window to the
          front, even a game in full screen on a Space of its own. Kimochi uses it only to find
          and bring forward the window you read from. Turn Kimochi on in System Settings →
          Privacy &amp; Security → Accessibility.
        </>
      }
    >
      <p className={style.status} role="status">
        <StatusDot tone={granted ? 'ok' : 'warn'} />
        {granted ? 'Accessibility is allowed.' : 'Not allowed yet. This updates on its own.'}
      </p>
      <StepActions>
        {granted ? (
          <Button variant="primary" asChild>
            <Link to="/ocr">Continue</Link>
          </Button>
        ) : (
          <>
            <Button variant="ghost" asChild>
              <Link to="/ocr">Skip for now</Link>
            </Button>
            <Button variant="primary" onClick={() => void requestAccessibility().catch(() => undefined)}>
              Open System Settings
              <ExternalLink />
            </Button>
          </>
        )}
      </StepActions>
    </Step>
  )
}

/**
 * Where the system asks what to share (a portal picker): nothing to grant up front, but the
 * screen or window can be chosen here already, through the same button the sidebar offers.
 */
function SystemPickerScreen(): JSX.Element {
  const { picked } = useSystemPick()
  const pickedName = picked ? picked.app || picked.name || 'your screen' : null
  return (
    <Step
      title="Choose what to read"
      lede={
        pickedName
          ? `Kimochi will read ${pickedName}. You can choose again at any time from the sidebar's Change source menu.`
          : 'Your desktop asks you to confirm the screen or window Kimochi may capture. Choose the game or app you want to read now, or later from the sidebar.'
      }
    >
      {!picked && (
        <div className={style.block}>
          <SystemPickerButton />
        </div>
      )}
      <StepActions>
        <Button variant={picked ? 'primary' : 'secondary'} asChild>
          <Link to="/ocr">{picked ? 'Continue' : 'Choose later'}</Link>
        </Button>
      </StepActions>
    </Step>
  )
}

// ---------------------------------------------------------------- OCR

function OcrScreen(): JSX.Element {
  return (
    <Step
      title="How should Kimochi read text?"
      lede="Local engines keep every scan on this computer. Cloud engines need a connection and may need credentials. You can change this later in Settings."
    >
      <EngineChooser />
      <StepActions>
        <Button variant="primary" asChild>
          <Link to="/engine">Continue</Link>
        </Button>
      </StepActions>
    </Step>
  )
}

// ---------------------------------------------------------------- dictionary management

/** Yomitan's own dictionary settings inside the guide, for imports and backups. */
function DictionarySettingsScreen(): JSX.Element {
  return (
    <section className={style.embedded} aria-label="Import or manage dictionaries">
      <DictionarySettingsPanel />
      <StepActions>
        <Button variant="primary" asChild>
          <Link to="/dictionaries">Done</Link>
        </Button>
      </StepActions>
    </section>
  )
}

// ---------------------------------------------------------------- done

/** Said on the last step when onboarding goes on without a dictionary (the engine step skipped). */
function NoDictionaryWarning(): JSX.Element | null {
  const ready = useDictionaryReady()
  if (ready !== false) return null
  return (
    <Callout tone="warn">
      No dictionary is set up, so nothing will look words up yet. Choose and download one in
      Settings → Dictionary whenever you are ready.
    </Callout>
  )
}

function DoneScreen(): JSX.Element {
  const capabilities = useCapabilities()
  const gaming =
    capabilities.os === 'linux' && capabilities.session?.compositor?.toLowerCase() === 'gamescope'
  return (
    <Step
      title={
        <span className={style.doneTitle}>
          <KimochiLogo size={40} />
          You&apos;re ready to read
        </span>
      }
      lede="Here is the whole loop. Settings has everything you chose here, whenever you want to change it."
    >
      <NoDictionaryWarning />
      <ol className={style.loop}>
        <li>
          <strong>Choose and crop.</strong>{' '}
          {gaming
            ? 'Gaming Mode shares the game screen on its own. Set a crop around the dialogue to skip menus and other text.'
            : 'Pick the game or window in the sidebar, then crop the area with the dialogue.'}
        </li>
        <li>
          <strong>Scan.</strong> Kimochi recognises the Japanese and adds each line to the Log.
        </li>
        <li>
          <strong>Look up.</strong> Hold Shift and hover a word, or use controller reading
          navigation, to see its meaning. Press B to go back to your game.
        </li>
      </ol>
      <DictionaryPractice />
      <StepActions>
        <Button variant="primary" asChild>
          <Link to="/main">Finish</Link>
        </Button>
      </StepActions>
    </Step>
  )
}

function CompleteOnboarding(): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    completeOnboarding().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught))
    )
  }, [attempt])
  if (!error) return <></>
  return (
    <Step title="Setup could not be saved" lede={error}>
      <StepActions>
        <Button
          variant="primary"
          onClick={() => {
            setError(null)
            setAttempt((n) => n + 1)
          }}
        >
          Try again
        </Button>
      </StepActions>
    </Step>
  )
}

// ---------------------------------------------------------------- window

function StepDots({ steps, current }: { steps: StepId[]; current: StepId | undefined }): JSX.Element | null {
  const index = current ? steps.indexOf(current) : -1
  if (index < 0) return null
  return (
    <span
      className={style.dots}
      role="img"
      aria-label={`Step ${index + 1} of ${steps.length}`}
    >
      {steps.map((step, i) => (
        <span key={step} data-state={i < index ? 'done' : i === index ? 'current' : undefined} />
      ))}
    </span>
  )
}

export default function WelcomeApp(): JSX.Element {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { steps, captureRoute, accessibilityRoute, back } = useFlow(pathname)
  const afterCapture = accessibilityRoute ?? '/ocr'
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const gaming = useCapabilities().session?.compositor?.toLowerCase() === 'gamescope'

  // Closing the guide only hides its window, so reopening it (Settings → General) would otherwise
  // land on whatever step it was closed at. A hidden → visible transition starts over from the
  // intro; a reload (an engine switch reloads every reader window) sees no transition and keeps
  // its step.
  useEffect(() => {
    let visible: boolean | null = null
    let unlisten: (() => void) | undefined
    let active = true
    onEvent<PanelStateEvent>('panel:state', (payload) => {
      if (payload?.label !== 'welcome') return
      if (visible === false && payload.visible) void navigate('/', { replace: true })
      visible = Boolean(payload.visible)
    })
      .then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      .catch(() => undefined)
    return () => {
      active = false
      unlisten?.()
    }
  }, [navigate])

  // The controller's B goes back a step rather than closing the window.
  useEffect(() => {
    const cancel = (event: Event): void => {
      if (back) {
        event.preventDefault()
        void navigate(back)
      }
    }
    document.addEventListener('kimochi:controller-back', cancel)
    return () => document.removeEventListener('kimochi:controller-back', cancel)
  }, [back, navigate])

  return (
    <StepActionsSlot.Provider value={slot}>
      <div className={style.window}>
        <div className={style.content} data-step={STEP_OF[pathname] ?? 'other'}>
          <div key={pathname} className={style.page}>
            <Routes>
              <Route index element={<IntroStep next={gaming ? '/ocr' : (captureRoute ?? afterCapture)} />} />
              <Route path="/screen-recording-permission" element={<ScreenPermissionScreen next={afterCapture} />} />
              <Route path="/accessibility" element={<AccessibilityScreen />} />
              <Route path="/system-picker" element={<SystemPickerScreen />} />
              <Route path="/ocr" element={<OcrScreen />} />
              <Route path="/engine" element={<EngineSetup />} />
              <Route path="/dictionaries" element={<DictionarySetup />} />
              <Route path="/dictionary-settings" element={<DictionarySettingsScreen />} />
              {/* The practice step became part of the last one. */}
              <Route path="/practice" element={<Navigate to="/done" replace />} />
              <Route path="/done" element={<DoneScreen />} />
              <Route path="/main" element={<CompleteOnboarding />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
        <footer className={style.bar}>
          <div className={style.barLead}>
            {back && (
              <Button variant="ghost" asChild className={style.back}>
                <Link to={back}>
                  <ChevronLeft />
                  Back
                </Link>
              </Button>
            )}
            <StepDots steps={steps} current={STEP_OF[pathname]} />
          </div>
          <div ref={setSlot} className={style.barActions} />
        </footer>
      </div>
    </StepActionsSlot.Provider>
  )
}
