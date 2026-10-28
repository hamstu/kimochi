import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { Check, Clock, Download, ExternalLink, Library } from 'lucide-react'
import { Badge, Button, Callout, Spinner, StatusDot, type Tone } from '@kit'
import { nativeError } from '../bridge/tauri'
import {
  DICTIONARY_ENGINES,
  openDictionarySettings,
  useDictionaryEngine,
  type DictionaryEngine
} from '../bridge/dictionaryEngine'
import { resolveYomitanApiUrl } from '@ui/yomitan-api-setup'
import { YomitanApiWizard } from '../components/YomitanApiSetup'
import Step from './Step'
import { StepActions } from './StepActions'
import { STEAM_ROUTE } from './steamRoute'
import { DictionaryReadiness } from '../components/DictionaryReadiness'
import { useDictionaryReadiness } from '../bridge/dictionaryReadiness'
import style from './WelcomeApp.module.css'

type Job = {
  id: string
  stage: string
  title?: string
  error?: string
  entries?: number
  progress?: { index?: number; count?: number }
}
type CatalogItem = { id: string; title: string; description: string }
/** An installed dictionary, and whether the current profile looks words up with it. */
type Installed = { title: string; importSuccess?: boolean; enabled?: boolean }

async function request<T>(params: object): Promise<T> {
  const host = (
    window as unknown as {
      __extensionHost?: { toBackend: (message: object) => Promise<T> }
    }
  ).__extensionHost
  if (!host)
    throw Error(
      'Dictionary setup is unavailable. Open dictionary settings or retry after Kimochi finishes starting.'
    )
  return host.toBackend({ action: '__setupDictionaries', params })
}

/** Where the guide goes after the dictionary step. */
const NEXT = STEAM_ROUTE

/**
 * Onboarding's dictionary step. Yomitan's quick setup (Jitendex) only applies to Yomitan inside Kimochi;
 * the Yomitan API gets its setup wizard (the helper, the browser setting, the connection); the
 * other engines bring their own first-run (Hachidori offers dictionaries, 10ten downloads its
 * own), so for them this explains that and opens their settings. DICTIONARY_ENGINES.md §8.
 */
export default function DictionarySetup(): JSX.Element {
  const [engine] = useDictionaryEngine()
  if (engine === 'yomitan') return <YomitanSetup />
  if (engine === 'custom-api') return <YomitanApiSetup />
  return <OtherEngineSetup engine={engine} />
}

type OtherEngine = Exclude<DictionaryEngine, 'yomitan' | 'custom-api'>

const ENGINE_SETUP: Record<OtherEngine, string> = {
  hachidori:
    'Hachidori offers a set of recommended dictionaries the first time its settings open, and imports Yomitan dictionaries and MDict files you already have.',
  tenten:
    '10ten works straight away with its bundled word dictionary, and downloads the full JMdict, kanji and names dictionaries in the background. There is nothing to import.'
}

/** The Yomitan API: its setup wizard, whose buttons go in the bar. Skippable at every step. */
function YomitanApiSetup(): JSX.Element {
  const navigate = useNavigate()
  const [, settings] = useDictionaryEngine()
  return (
    <Step
      title="Connect your browser's Yomitan"
      lede="Look words up with the Yomitan in your browser, using its dictionaries and settings."
    >
      <YomitanApiWizard
        url={resolveYomitanApiUrl(settings.customApiUrl)}
        Actions={StepActions}
        onFinish={() => void navigate(NEXT)}
        finishLabel="Continue"
        onSkip={() => void navigate(NEXT)}
      />
    </Step>
  )
}

function OtherEngineSetup({ engine }: { engine: OtherEngine }): JSX.Element {
  const name = DICTIONARY_ENGINES[engine].name
  const runtime = useDictionaryReadiness(engine)
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const open = (): void => {
    setError(null)
    openDictionarySettings().catch((caught: unknown) => setError(nativeError(caught).message))
  }
  return (
    <Step
      title={`Set up ${name}`}
      lede={`Kimochi looks words up with ${name}. You can switch dictionary engines later in Settings → Dictionary.`}
    >
      <div className={style.block}>
        <p className={style.text}>{ENGINE_SETUP[engine]}</p>
        <DictionaryReadiness engine={engine} />
        {runtime.settingsReady && <div>
          <Button onClick={open}>
            <ExternalLink />
            Open {name} settings
          </Button>
        </div>}
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
      <StepActions>
        {runtime.phase !== 'ready' && <Button asChild><Link to={NEXT}>Set up later</Link></Button>}
        <Button variant="primary" disabled={runtime.phase !== 'ready'} onClick={() => void navigate(NEXT)}>
          Continue
        </Button>
      </StepActions>
    </Step>
  )
}

/** The job's line: what it is doing, in words. */
function jobLine(job: Job): { tone: Tone; text: string } {
  if (job.stage === 'complete')
    return {
      tone: 'ok',
      text: `${job.title ?? 'The dictionary'} is installed and enabled (${job.entries?.toLocaleString() ?? 0} entries).`
    }
  if (job.stage === 'failed') return { tone: 'danger', text: 'Setup did not finish.' }
  const stage = job.stage.charAt(0).toUpperCase() + job.stage.slice(1)
  return { tone: 'accent', text: `${stage}… It carries on in the background if you continue.` }
}

function YomitanSetup(): JSX.Element {
  const navigate = useNavigate()
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  // What is installed already (null while it is asked): someone going through the guide again,
  // or who imported before reaching this step, is not offered a dictionary they do not need.
  const [installed, setInstalled] = useState<Installed[] | null>(null)
  useEffect(() => {
    void request<{ catalog: CatalogItem[]; dictionaries?: Installed[]; job?: Job | null }>({
      command: 'catalog'
    })
      .then((result) => {
        setCatalog(result.catalog)
        setInstalled((result.dictionaries ?? []).filter((item) => item.importSuccess !== false))
        // The setup runs in the overlay's backend and outlives this step: one started before the
        // step was left (or the window hidden or reloaded) carries on here with its progress.
        if (result.job) setJob((current) => current ?? result.job ?? null)
      })
      .catch((caught) => {
        setError(String(caught))
        setInstalled([])
      })
  }, [])
  const [starting, setStarting] = useState(false)
  // Which way to add a dictionary. Choosing a card only selects it, as on the guide's other steps;
  // the bar's primary button acts on it (installs, opens dictionary settings, or moves on).
  const [choice, setChoice] = useState<string | null>(null)
  useEffect(() => {
    if (!job || ['complete', 'failed'].includes(job.stage)) return
    let active = true
    const timer = setInterval(() => {
      void request<Job>({ command: 'status', id: job.id })
        .then((next) => {
          if (active) {
            setJob(next)
            setError(null)
          }
        })
        .catch((caught) => {
          if (active) setError(String(caught))
        })
    }, 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [job])
  const start = async (dictionaryId: string): Promise<void> => {
    setStarting(true)
    setError(null)
    try {
      const result = await request<{ id: string }>({ command: 'start', dictionaryId })
      setJob({ ...result, stage: 'starting' })
    } catch (caught) {
      setError(String(caught))
    } finally {
      setStarting(false)
    }
  }
  const busy = starting || (job !== null && !['complete', 'failed'].includes(job.stage))
  const done = job?.stage === 'complete'
  const ready = installed?.filter((item) => item.enabled) ?? []
  // Offered only once the check is back and found nothing to look words up with (or a setup
  // started here is under way or finished, to keep its progress in place).
  const offer = installed !== null && (ready.length === 0 || job !== null)
  const line = job ? jobLine(job) : null
  const count = job?.progress?.count ?? 0
  // The recommended dictionary until another card is chosen.
  const selected = choice ?? (catalog[0] ? `install:${catalog[0].id}` : LATER)
  const installing = catalog.find((item) => selected === `install:${item.id}`)
  const primary: { label: string; act: () => void; disabled?: boolean } = !offer
    ? { label: 'Continue', act: () => void navigate(NEXT) }
    : selected === OWN
      ? { label: 'Open dictionary settings', act: () => void navigate('/dictionary-settings') }
      : installing && !busy && !done
        ? { label: `Install ${installing.title}`, act: () => void start(installing.id), disabled: starting }
        : { label: busy ? 'Continue while installing' : 'Continue', act: () => void navigate(NEXT) }
  return (
    <Step
      title={offer || installed === null ? 'Set up Yomitan' : 'Your dictionaries are ready'}
      lede={
        offer || installed === null
          ? 'Yomitan needs at least one dictionary before it can show you what words mean. Pick how you’d like to add one.'
          : 'Yomitan already has dictionaries to look words up with, so there is nothing to set up. You can add or change them any time in Settings → Dictionary.'
      }
    >
      {installed === null && !error && (
        <p className="k-description" role="status">
          Checking your dictionaries…
        </p>
      )}
      {!offer && ready.length > 0 && (
        <div className={style.block}>
          <p className={style.status}>
            <StatusDot tone="ok" />
            {ready.length === 1 ? '1 dictionary is' : `${ready.length} dictionaries are`} enabled in
            your current profile.
          </p>
          <ul className={style.dictionaries}>
            {ready.map((item) => (
              <li key={item.title}>{item.title}</li>
            ))}
          </ul>
        </div>
      )}
      {offer && ready.length === 0 && (installed?.length ?? 0) > 0 && (
        <Callout tone="warn">
          {installed?.length === 1 ? 'A dictionary is' : `${installed?.length} dictionaries are`}{' '}
          installed, but none is enabled in your current profile. Enable one in Yomitan’s settings,
          or install one here.
        </Callout>
      )}
      {offer && (
        <div className={style.options} role="radiogroup" aria-label="How to add a dictionary">
          {catalog.map((item) => {
            const thisJob = job && done ? 'done' : busy ? 'busy' : null
            const value = `install:${item.id}`
            return (
              <ChoiceCard
                key={item.id}
                selected={selected === value}
                onSelect={() => setChoice(value)}
                recommended
                icon={thisJob === 'busy' ? <Spinner /> : thisJob === 'done' ? <Check /> : <Download />}
                title={
                  thisJob === 'done'
                    ? `${item.title} installed`
                    : thisJob === 'busy'
                      ? `Installing ${item.title}…`
                      : `Install ${item.title}`
                }
                detail="Japanese–English definitions, downloaded and set up for you."
                badge={!thisJob && <Badge tone="accent">Recommended</Badge>}
              />
            )
          })}
          <ChoiceCard
            selected={selected === OWN}
            onSelect={() => setChoice(OWN)}
            icon={<Library />}
            title="Choose your own"
            detail="Import dictionaries or a Yomitan backup in Yomitan’s settings."
          />
          <ChoiceCard
            selected={selected === LATER}
            onSelect={() => setChoice(LATER)}
            icon={<Clock />}
            title="Do it later"
            detail="Add a dictionary any time in Settings → Dictionary."
          />
        </div>
      )}
      {line && (
        <div className={style.job}>
          <p className={style.status} role="status">
            <StatusDot tone={line.tone} />
            {line.text}
          </p>
          {job?.stage === 'importing' && count > 0 && (
            <progress
              className={style.progress}
              aria-label="Dictionary import progress"
              value={job.progress?.index ?? 0}
              max={count}
            />
          )}
        </div>
      )}
      {(error || job?.error) && <Callout tone="danger">{error || job?.error}</Callout>}
      {!offer && installed !== null && (
        <p className={style.aside}>
          Want more?{' '}
          <Link to="/dictionary-settings" className={style.link}>
            Import or manage dictionaries
          </Link>
        </p>
      )}
      <StepActions>
        <Button variant="primary" disabled={primary.disabled} onClick={primary.act}>
          {primary.label}
        </Button>
      </StepActions>
    </Step>
  )
}

const OWN = 'own'
const LATER = 'later'

/** One way to add a dictionary: a radio card that only selects (`k-choice`, on when chosen). */
function ChoiceCard({
  selected,
  onSelect,
  recommended = false,
  icon,
  title,
  detail,
  badge
}: {
  selected: boolean
  onSelect: () => void
  recommended?: boolean
  icon: JSX.Element
  title: string
  detail: string
  badge?: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`k-choice ${style.option}`}
      data-recommended={recommended ? '' : undefined}
      data-state={selected ? 'on' : undefined}
      onClick={onSelect}
    >
      <span className={style.optionIcon}>{icon}</span>
      <span className={style.optionTitle}>{title}</span>
      <span className={style.optionDetail}>{detail}</span>
      {badge}
    </button>
  )
}

export function DictionaryPractice(): JSX.Element {
  const [engine] = useDictionaryEngine()
  // The check asks Yomitan's backend directly; the other engines are tried by hovering text.
  if (engine !== 'yomitan') return <></>
  return <YomitanPractice />
}

function YomitanPractice(): JSX.Element {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, setPending] = useState(false)
  async function check(): Promise<void> {
    setPending(true)
    try {
      const found = await request<{ text: string; matches: number }>({ command: 'practice' })
      setResult(
        found.matches > 0
          ? { ok: true, text: `${found.text}: ${found.matches} dictionary results found. Your dictionary is ready.` }
          : {
              ok: false,
              text: 'No definitions found yet. Finish importing and enable a Japanese dictionary in dictionary settings.'
            }
      )
    } catch (error) {
      setResult({ ok: false, text: String(error) })
    } finally {
      setPending(false)
    }
  }
  return (
    <div className={style.practice}>
      <Button disabled={pending} onClick={() => void check()}>
        {pending ? 'Checking…' : (
          <>
            Test a lookup of <span lang="ja">日本語</span>
          </>
        )}
      </Button>
      {result && (
        <p className={style.status} role="status">
          <StatusDot tone={result.ok ? 'ok' : 'warn'} />
          {result.text}
        </p>
      )}
    </div>
  )
}
