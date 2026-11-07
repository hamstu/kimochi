/**
 * DEV-ONLY: the UI studio's Presets tab (presets.ts). Presets jump the frame to a whole state in one
 * click; flows reload it into their starting state and then play their steps inside it, or step
 * through them one at a time.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Pause, Play, RotateCcw, SkipForward } from 'lucide-react'
import { IconButton, Spinner, cn } from '@kit'
import type { PreviewControl } from '../preview-control'
import { FLOWS, PRESETS, type Flow, type PresetState } from './presets'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Whether `ms` from now has passed (the flows' waits run from clicks, never while rendering). */
function deadline(ms: number): () => boolean {
  const end = Date.now() + ms
  return () => Date.now() > end
}

/** The flow being walked through: the next step to run, and what it is doing. */
interface Run {
  flow: Flow
  /** The next step to run (steps.length: done). */
  next: number
  status: 'loading' | 'ready' | 'playing' | 'waiting' | 'done' | 'stopped'
  note?: string
}

export function PresetsPanel({
  apply,
  control
}: {
  /** Reload the frame into a state. */
  apply: (state: PresetState) => void
  /** The page's control, once the frame has loaded and installed it (null before). */
  control: () => PreviewControl | null
}): ReactNode {
  const [run, setRun] = useState<Run | null>(null)
  const [applied, setApplied] = useState<string | null>(null)
  // Bumped to cancel whatever the flow is doing (a new flow, a preset, Pause, Restart).
  const token = useRef(0)
  useEffect(() => () => void token.current++, [])

  const live = (mine: number): boolean => mine === token.current

  /** Reload into the flow's start, and wait for the new page's control (and a moment to settle). */
  async function load(flow: Flow, mine: number): Promise<boolean> {
    const before = control()
    setRun({ flow, next: 0, status: 'loading' })
    apply(flow.start)
    const late = deadline(15000)
    while (live(mine)) {
      const now = control()
      if (now && now !== before) break
      if (late()) {
        setRun({ flow, next: 0, status: 'stopped', note: 'The page did not load.' })
        return false
      }
      await sleep(150)
    }
    await sleep(1200)
    return live(mine)
  }

  /** Run step `index` (after its pause, when playing); false when the flow should stop. */
  async function step(flow: Flow, index: number, mine: number, playing: boolean): Promise<boolean> {
    const s = flow.steps[index]
    if (playing) {
      await sleep(s.after ?? 1500)
      if (!live(mine)) return false
    }
    const page = control()
    if (!page) {
      setRun({ flow, next: index, status: 'stopped', note: 'The page is not ready.' })
      return false
    }
    try {
      s.run?.(page)
    } catch (error) {
      setRun({ flow, next: index, status: 'stopped', note: `Step failed: ${String(error)}` })
      return false
    }
    if (s.until) {
      setRun({ flow, next: index, status: 'waiting' })
      const late = deadline(s.timeout ?? 30000)
      while (!s.until(control() ?? page)) {
        if (!live(mine)) return false
        if (late()) {
          setRun({ flow, next: index + 1, status: 'stopped', note: 'Gave up waiting for this step.' })
          return false
        }
        await sleep(250)
      }
    }
    if (!live(mine)) return false
    const done = index + 1 >= flow.steps.length
    setRun({ flow, next: index + 1, status: done ? 'done' : playing ? 'playing' : 'ready' })
    return true
  }

  async function play(flow: Flow, from: number | null): Promise<void> {
    const mine = ++token.current
    let index = from ?? 0
    if (from === null && !(await load(flow, mine))) return
    setRun({ flow, next: index, status: 'playing' })
    while (index < flow.steps.length) {
      if (!(await step(flow, index, mine, true))) return
      index++
    }
  }

  async function restart(flow: Flow): Promise<void> {
    const mine = ++token.current
    if (await load(flow, mine)) setRun({ flow, next: 0, status: 'ready' })
  }

  async function stepOnce(r: Run): Promise<void> {
    const mine = ++token.current
    await step(r.flow, r.next, mine, false)
  }

  const pause = (): void => {
    token.current++
    setRun((r) => (r ? { ...r, status: 'ready' } : r))
  }

  const busy = run && (run.status === 'loading' || run.status === 'playing' || run.status === 'waiting')

  return (
    <div className="studio-panel-scroll">
      <div className="studio-panel-head">
        <div>
          <h2>Presets</h2>
          <p>Jump to a whole state, or play a flow through the states it passes.</p>
        </div>
      </div>

      {FLOWS.map((group) => (
        <section key={group.title} className="studio-group">
          <h3>Flows · {group.title}</h3>
          {group.items.map((flow) => {
            const current = run?.flow.id === flow.id ? run : null
            return (
              <div key={flow.id} className="studio-flow" data-active={current ? '' : undefined}>
                <div className="studio-flow-head">
                  <div className="studio-flow-text">
                    <span>{flow.label}</span>
                    <small>{flow.detail}</small>
                  </div>
                  <div className="studio-flow-actions">
                    {current && busy ? (
                      <IconButton size="sm" label="Pause" onClick={pause}>
                        <Pause />
                      </IconButton>
                    ) : (
                      <IconButton
                        size="sm"
                        label={current && current.next > 0 && current.status !== 'done' ? 'Play the rest' : 'Play from the start'}
                        onClick={() =>
                          void play(flow, current && current.next > 0 && current.status !== 'done' ? current.next : null)
                        }
                      >
                        <Play />
                      </IconButton>
                    )}
                    <IconButton
                      size="sm"
                      label={current ? 'Next step' : 'Load it, to step through by hand'}
                      disabled={Boolean(current && (busy || current.next >= flow.steps.length))}
                      onClick={() => (current ? void stepOnce(current) : void restart(flow))}
                    >
                      <SkipForward />
                    </IconButton>
                    {current && (
                      <IconButton size="sm" label="Back to its start" onClick={() => void restart(flow)}>
                        <RotateCcw />
                      </IconButton>
                    )}
                  </div>
                </div>
                {current && (
                  <ol className="studio-flow-steps">
                    {flow.steps.map((s, i) => {
                      const state =
                        i < current.next ? 'done' : i === current.next && (current.status === 'waiting' || current.status === 'playing') ? 'now' : 'todo'
                      // While waiting, the step that ran is still the one under way.
                      const waiting = current.status === 'waiting' && i === current.next
                      return (
                        <li key={s.label} data-state={waiting ? 'now' : state}>
                          <span className="studio-flow-mark" aria-hidden>
                            {state === 'done' ? <Check /> : waiting ? <Spinner /> : <span className="k-num">{i + 1}</span>}
                          </span>
                          {s.label}
                        </li>
                      )
                    })}
                  </ol>
                )}
                {current?.status === 'loading' && <p className="studio-flow-note">Loading its starting state…</p>}
                {current?.note && <p className="studio-flow-note" data-tone="danger">{current.note}</p>}
              </div>
            )
          })}
        </section>
      ))}

      {PRESETS.map((group) => (
        <section key={group.title} className="studio-group">
          <h3>Presets · {group.title}</h3>
          <div className="studio-presets">
            {group.items.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={cn('studio-preset', preset.id === 'reset' && 'studio-preset-reset')}
                data-active={applied === preset.id || undefined}
                onClick={() => {
                  token.current++
                  setRun(null)
                  setApplied(preset.id)
                  apply(preset.state)
                }}
              >
                <span>{preset.label}</span>
                <small>{preset.detail}</small>
              </button>
            ))}
          </div>
        </section>
      ))}
      <p className="studio-help studio-pad studio-presets-foot">
        Add your own in <code>frontend/dev/studio/presets.ts</code>.
      </p>
    </div>
  )
}
