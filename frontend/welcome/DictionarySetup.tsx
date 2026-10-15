import { useEffect, useState, type JSX } from 'react'
import { Link, useNavigate } from 'react-router'
import { Download, ExternalLink } from 'lucide-react'
import { Button, Callout, StatusDot, type Tone } from '@kit'
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
const NEXT = '/done'

/**
 * Onboarding's dictionary step. Yomitan's quick setup (Jitendex) only applies to Built-in Yomitan;
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
      lede="Kimochi's pop-up looks words up through the Yomitan you already use in your browser, with its dictionaries and settings. It needs a small helper and one setting in Yomitan."
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
  useEffect(() => {
    void request<{ catalog: CatalogItem[] }>({ command: 'catalog' })
      .then((result) => setCatalog(result.catalog))
      .catch((caught) => setError(String(caught)))
  }, [])
  const [starting, setStarting] = useState(false)
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
  // One recommended dictionary (Jitendex): its setup is the step's main action, in the bar.
  const only = catalog.length === 1 ? catalog[0] : null
  const offerInBar = only !== null && !busy && !done
  const line = job ? jobLine(job) : null
  const count = job?.progress?.count ?? 0
  return (
    <Step
      title="Add a dictionary"
      lede="Built-in Yomitan is downloaded and runs inside Kimochi, so there is no browser extension to install. It needs at least one dictionary to look words up: set one up here, or import the dictionaries and settings you exported from Yomitan in your browser."
    >
      {catalog.map((item) => (
        <div key={item.id} className={style.block}>
          <p className={style.text}>
            <strong>{item.title}</strong> · {item.description}
          </p>
          <p className="k-description">
            Quick setup downloads it and enables it in your current profile. Existing dictionaries
            and preferences are kept.
          </p>
          {!only && (
            <div>
              <Button variant="primary" disabled={busy} onClick={() => void start(item.id)}>
                <Download />
                Set up {item.title}
              </Button>
            </div>
          )}
        </div>
      ))}
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
      <p className={style.aside}>
        Already have dictionaries or a Yomitan settings backup?{' '}
        <Link to="/dictionary-settings" className={style.link}>
          Import or manage dictionaries
        </Link>
      </p>
      <StepActions>
        {offerInBar ? (
          <>
            <Button variant="ghost" asChild>
              <Link to={NEXT}>Skip</Link>
            </Button>
            <Button variant="primary" onClick={() => void start(only.id)}>
              <Download />
              Set up {only.title}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => void navigate(NEXT)}>
            {busy ? 'Continue while importing' : 'Continue'}
          </Button>
        )}
      </StepActions>
    </Step>
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
